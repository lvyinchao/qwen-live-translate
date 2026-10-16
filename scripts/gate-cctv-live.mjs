import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { isolatedTestEnv } from './test-environment.mjs';

const videoUrl = 'https://tv.cctv.cn/2026/10/10/VIDEI34ipCK8rpMApfhxRnYs261010.shtml';
await fs.mkdir('work', {recursive:true});
await fs.mkdir('outputs', {recursive:true});
await fs.mkdir('output/playwright', {recursive:true});
const base = await fs.mkdtemp(path.resolve('work/cctv-live-'));
const extension = path.join(base, 'extension');
await fs.cp(path.resolve(process.env.EXTENSION_DIR ?? '.output/chrome-mv3'), extension, {recursive:true});
const context = await chromium.launchPersistentContext(path.join(base, 'profile'), {
  env: isolatedTestEnv(), channel:'chromium', headless:true,
  ignoreDefaultArgs:['--disable-extensions'],
  args:['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
});
const runtime = crypto.createHash('sha256');
const hashTree = async (directory) => {
  for (const name of (await fs.readdir(directory)).sort()) {
    const entry = path.join(directory, name);
    if ((await fs.stat(entry)).isDirectory()) await hashTree(entry);
    else { runtime.update(path.relative(extension, entry).split(path.sep).join('/')); runtime.update(await fs.readFile(entry)); }
  }
};
await hashTree(extension);
const report = {at:new Date().toISOString(),runtimeSha256:runtime.digest('hex'), page:videoUrl,
  scope:'Real anonymous CCTV VOD page and unmodified extension decoder; delayed panel opening, paused-player ahead reads. No model call, translated-playback or language-quality claim.', checks:[], windows:[]};
try {
  await context.routeWebSocket(/^wss?:/, socket => socket.close({code:1000,reason:'Media acquisition test: no provider calls'}));
  const cdp = await context.browser().newBrowserCDPSession();
  const {id} = await cdp.send('Extensions.loadUnpacked',{path:extension});
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/THIRD_PARTY_NOTICES.md`);
  report.version = await setup.evaluate(()=>chrome.runtime.getManifest().version);
  const page = await context.newPage();
  await page.goto(videoUrl,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>document.querySelector('video')?.duration>2000, undefined, {timeout:45000});
  await page.locator('video').evaluate(v=>v.pause());
  report.native = await page.locator('video').evaluate(v=>({duration:v.duration,time:v.currentTime,paused:v.paused,protected:!!v.mediaKeys}));
  await page.screenshot({path:process.env.CCTV_PAGE_SCREEN ?? 'output/playwright/cctv-page.png',fullPage:false});
  // No sidepanel/observation lease existed while the native player loaded.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.bringToFront();
  const tabId = await setup.evaluate(async(url)=>(await chrome.tabs.query({})).find(t=>t.url===url)?.id,videoUrl);
  const call=(type,extra={})=>setup.evaluate(async({type,extra})=>{
    const r=await chrome.runtime.sendMessage({target:'background',type,...extra});
    if(!r?.ok)throw Error(r?.error??'Missing extension response');
    return r.value;
  },{type,extra});
  const candidates=await call('media:discover',{tabId});
  report.candidates=candidates.map(c=>({id:c.id,title:c.title,duration:c.duration,sourceStatus:c.sourceStatus,reason:c.sourceReason,
    sourceHost:c.source&&new URL(c.source.url).hostname,sourceKind:c.source?.kind,detectedMedia:c.detectedMedia}));
  const selected=candidates.find(c=>c.source && c.duration>2000);
  if(!selected){report.prefetchable=false;throw Error('The CCTV native video has no ahead-readable source');}
  else {
    report.prefetchable=true;
    report.checks.push('A late scan resolves a full HLS source for the paused 44-minute native player');
    await panel.setViewportSize({width:480,height:900});
    await panel.waitForFunction(()=>document.querySelector('.video-choice'));
    await panel.screenshot({path:process.env.CCTV_PANEL_SCREEN ?? 'output/playwright/cctv-ready-panel.png',fullPage:true});
    await call('media:headers',{source:selected.source});
    const asset=(await fs.readdir(path.join(extension,'assets'))).find(n=>/^decode-.*\.js$/.test(n));
    for(const [start,end] of [[0,30],[1180.15,1210.15],[2660,2678.68]]){
      const before=await page.locator('video').evaluate(v=>({time:v.currentTime,paused:v.paused}));
      const result=await setup.evaluate(async({asset,source,start,end})=>{
        const worker=new Worker(chrome.runtime.getURL('assets/'+asset),{type:'module'});
        try{return await new Promise(resolve=>{
          const timer=setTimeout(()=>resolve({ok:false,error:'decode timeout'}),65000);
          worker.onmessage=e=>{
            if(e.data.id!=='cctv')return;
            clearTimeout(timer);
            if(!e.data.ok){resolve({ok:false,error:e.data.error});return;}
            const pcm=new Float32Array(e.data.samples);
            let power=0;for(const x of pcm)power+=x*x;
            resolve({ok:true,decodedStart:e.data.decodedStart,decodedEnd:e.data.decodedEnd,samples:pcm.length,rms:Math.sqrt(power/pcm.length)});
          };
          worker.onerror=()=>{clearTimeout(timer);resolve({ok:false,error:'worker error'});};
          worker.postMessage({id:'cctv',type:'decode',source,start,end});
        });}finally{worker.terminate();}
      },{asset,source:selected.source,start,end});
      const after=await page.locator('video').evaluate(v=>({time:v.currentTime,paused:v.paused}));
      report.windows.push({start,end,...result,before,after});
      if(!result.ok)throw Error(result.error);
      if(!before.paused||!after.paused||Math.abs(after.time-before.time)>0.05)throw Error('Native video advanced during ahead decoding');
      if(result.samples!==Math.ceil((end-start)*16000)||result.rms<=0.00001)throw Error('Missing or silent decoded audio');
      if(result.decodedStart > start + 0.1 || result.decodedEnd < end - 0.1)throw Error('Decoded media timestamps do not cover the requested source window');
    }
    report.checks.push('Beginning, 19-minute middle and ending windows decode to non-silent mono 16 kHz PCM while the native player stays paused');
  }
  report.passed=!!selected;
}catch(error){report.error=error.message;report.passed=false;process.exitCode=1;}
finally{
  await context.close();
  await fs.writeFile(process.env.CCTV_REPORT ?? 'outputs/cctv-live-verification.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await fs.rm(base,{recursive:true,force:true});
}
