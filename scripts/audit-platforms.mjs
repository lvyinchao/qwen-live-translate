import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { isolatedTestEnv } from './test-environment.mjs';

// Manual, anonymous compatibility assessment. Not a provider/voice-quality gate.
// node scripts/audit-platforms.mjs work/spec.json work/results.json
const [specFile, reportFile] = process.argv.slice(2);
if (!specFile || !reportFile) throw Error('Provide a sample specification and report path');
const samples = JSON.parse(await fs.readFile(specFile, 'utf8'));
if (!Array.isArray(samples) || samples.some(s => !s.platform || !/^https:\/\//.test(s.url)))
  throw Error('Each sample requires a platform and public HTTPS page URL');
await fs.mkdir('work', {recursive:true});
await fs.mkdir('output/playwright', {recursive:true});
await fs.mkdir(path.dirname(path.resolve(reportFile)), {recursive:true});
const directory = await fs.mkdtemp(path.resolve('work/platform-audit-'));
const extension = path.join(directory, 'extension');
await fs.cp(path.resolve(process.env.EXTENSION_DIR ?? 'outputs/extension'), extension, {recursive:true});
const digest = crypto.createHash('sha256');
async function hashTree(folder) {
  for (const name of (await fs.readdir(folder)).sort()) {
    const file = path.join(folder,name);
    if ((await fs.stat(file)).isDirectory()) await hashTree(file);
    else {digest.update(path.relative(extension,file).split(path.sep).join('/'));digest.update(await fs.readFile(file));}
  }
}
await hashTree(extension);
const manifest = JSON.parse(await fs.readFile(path.join(extension,'manifest.json'),'utf8'));
const headless = process.env.AUDIT_HEADLESS !== '0';
const report = {
  auditSchemaVersion:3,
  at:new Date().toISOString(), version:manifest.version, runtimeSha256:digest.digest('hex'),
  scope:'Anonymous public-page checks in isolated Chrome, using the exact extension version and runtime hash above. Detection, source selection and paused ahead-decoding are separate. No translation model calls, user account, paywall/DRM bypass or platform-wide guarantee.',
  environment:{os:process.platform,arch:process.arch,headless,account:'anonymous; a new profile for each sample'},
  method:{windows:2,maxWindowSeconds:8,decodeTimeoutSeconds:60,expectedDurationCheck:true,reuseDecoderAcrossWindows:true,pauseReadback:'non-mutating',finitePCMCheck:true},
  samples:[],
};
const publicPage = value => {
  try {const u=new URL(value);if(!['http:','https:'].includes(u.protocol))return '<browser-error-or-blank-page>';const q=new URLSearchParams();for(const key of ['v','p','bvid','video_id'])if(u.searchParams.has(key))q.set(key,u.searchParams.get(key));return u.origin+u.pathname+(q.size?'?'+q:'');}
  catch {return '<unavailable>';}
};
const safeError = error => String(error?.message ?? error).replace(/https?:\/\/[^\s"<>]+/g, value=>{
  try{return new URL(value).origin+'/<redacted-resource>';}catch{return '<redacted-resource>';}
}).slice(0,800);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function nativeState(page, pause=false) {
  const frames=[];
  for(const frame of page.frames()) {
    try {
      const value=await frame.evaluate(pause=>{
        const all=[];
        const walk=root=>{all.push(...root.querySelectorAll('video'));for(const e of root.querySelectorAll('*'))if(e.shadowRoot)walk(e.shadowRoot);};
        walk(document);
        return {encryptedEvents:window.__auditEncryptedEvents??0,videos:all.map(v=>{
          if(pause)v.pause();
          const rect=v.getBoundingClientRect();
          let srcType='empty',srcHost='';try{const u=new URL(v.currentSrc||v.src);srcType=u.protocol;srcHost=u.hostname;}catch{}
          return {id:v.dataset.qvdId??null,duration:Number.isFinite(v.duration)?v.duration:null,time:v.currentTime,paused:v.paused,readyState:v.readyState,mediaError:v.error?.code??null,
            protected:!!v.mediaKeys,displayed:rect.width>100&&rect.height>60&&getComputedStyle(v).visibility!=='hidden',width:rect.width,height:rect.height,srcType,srcHost};
        })};
      },pause);
      frames.push({origin:new URL(frame.url()).origin,...value});
    } catch {}
  }
  return frames;
}
async function tryPlay(page) {
  const results=[];
  for(const frame of page.frames()) {
    try {results.push(...await frame.evaluate(async()=>{
      const all=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>100&&r.height>60;});
      return await Promise.all(all.map(async v=>{try{await Promise.race([v.play(),new Promise((_,reject)=>setTimeout(()=>reject(Error('play pending')),2500))]);return 'started';}catch(e){return e.name+': '+e.message;}}));
    }));}catch{}
  }
  return results.map(safeError);
}
async function decode(setup, asset, source, start, end, expectedDuration) {
  return setup.evaluate(async({asset,source,start,end,expectedDuration})=>{
    const worker=window.__auditDecoder??=new Worker(chrome.runtime.getURL('assets/'+asset),{type:'module'});
    const requestId=crypto.randomUUID();
    return await new Promise(resolve=>{
      const timer=setTimeout(()=>{
        worker.terminate();delete window.__auditDecoder;
        resolve({ok:false,error:'ahead decode timeout (60s production budget)'});
      },60000);
      worker.onmessage=e=>{
        if(e.data.id!==requestId)return;clearTimeout(timer);
        if(!e.data.ok){resolve({ok:false,error:e.data.error});return;}
        const pcm=new Float32Array(e.data.samples);let power=0,invalidSamples=0;for(const n of pcm){if(Number.isFinite(n))power+=n*n;else invalidSamples++;}
        const rms=pcm.length&&!invalidSamples?Math.sqrt(power/pcm.length):null;
        resolve({ok:true,decodedStart:e.data.decodedStart,decodedEnd:e.data.decodedEnd,samples:pcm.length,rms,finitePCM:invalidSamples===0,invalidSamples,nonSilent:rms!==null&&rms>1e-6});
      };
      worker.onerror=()=>{clearTimeout(timer);resolve({ok:false,error:'decoder worker error'});};
      worker.postMessage({id:requestId,type:'decode',source,start,end,expectedDuration});
    });
  },{asset,source,start,end,expectedDuration});
}
try {
  for(const [index,spec] of samples.entries()) {
    const started=Date.now();
    const item={platform:spec.platform,label:spec.label??'',url:publicPage(spec.url),mode:spec.mode??'early',accessNote:spec.accessNote??'',at:new Date().toISOString(),windows:[]};
    report.samples.push(item);
    const profile=path.join(directory,'profile-'+index);
    let context;
    let watchdog;
    try {
      item.stage='browser';
      context=await chromium.launchPersistentContext(profile,{
        env:isolatedTestEnv(),channel:'chromium',headless,timeout:25000,
        ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required'],
      });
      watchdog=setTimeout(()=>{
        item.timedOut=true;
        void context.close().catch(()=>{});
      },210000+Math.min(90000,Math.max(0,Number(spec.settleMs)||0)));
      context.setDefaultTimeout(8000);
      report.environment.browser=context.browser().version();
      await context.routeWebSocket(/^wss:\/\/(?:[^/]+\.)?(?:maas|dashscope)\.aliyuncs\.com(?:\/|$)/,socket=>socket.close({code:1000,reason:'Compatibility audit: no provider calls'}));
      await context.addInitScript(()=>{window.__auditEncryptedEvents=0;document.addEventListener('encrypted',()=>window.__auditEncryptedEvents++,true);});
      const cdp=await context.browser().newBrowserCDPSession();
      const {id}=await cdp.send('Extensions.loadUnpacked',{path:extension});
      const setup=await context.newPage();await setup.goto(`chrome-extension://${id}/THIRD_PARTY_NOTICES.md`);
      const call=(type,extra={})=>setup.evaluate(async({type,extra})=>{const r=await chrome.runtime.sendMessage({target:'background',type,...extra});if(!r?.ok)throw Error(r?.error??'No extension response');return r.value;},{type,extra});
      const settings=await call('settings:get');
      if(settings.hasKey||settings.autoSaveFiles)throw Error('Audit profile must have no credentials and saving off');
      const next=context.waitForEvent('page');
      const target=await setup.evaluate(async()=>{const t=await chrome.tabs.create({url:'about:blank',active:true});return {id:t.id,windowId:t.windowId};});
      const page=await next;
      const observe=()=>setup.evaluate(({id,windowId})=>{
        window.__auditPort?.disconnect();clearInterval(window.__auditTimer);
        const p=chrome.runtime.connect({name:'timbradub-panel'});window.__auditPort=p;
        const renew=()=>p.postMessage({type:'watch',tabId:id,windowId});renew();window.__auditTimer=setInterval(renew,4000);
      },target);
      if(item.mode==='early')await observe();
      const mediaTraffic=[];
      page.on('response',response=>{
        const url=new URL(response.url());const type=response.headers()['content-type']??'';
        const suffix=url.pathname.match(/\.(m3u8|mpd|ts|m4s|mp4|m4a|webm)$/i)?.[1]?.toLowerCase();
        if(suffix||/^(?:audio|video)\/|mpegurl|dash\+xml/.test(type)){
          mediaTraffic.push({host:url.hostname,suffix:suffix??'',mime:type.split(';')[0],status:response.status()});
          if(mediaTraffic.length>80)mediaTraffic.shift();
        }
      });
      try{const response=await page.goto(spec.url,{waitUntil:'domcontentloaded',timeout:25000});item.httpStatus=response?.status();}
      catch(error){item.navigationError=safeError(error);}
      item.stage='page-initialization';
      item.currentPage=publicPage(page.url());
      item.title=(await page.title().catch(()=>'' )).slice(0,240);
      await sleep(3500);
      const clickControl=async()=>{
        try{const p=page.locator(spec.playSelector).first();await p.waitFor({state:'visible',timeout:5000});await p.click({timeout:5000});item.playControlClicked=true;}
        catch(error){item.playControlError=safeError(error);}
      };
      if(spec.playSelector&&!spec.controlAfterSettle)await clickControl();
      item.playAttempts=await tryPlay(page);
      await sleep(item.mode==='late'?5000:2000);
      if(spec.settleMs){
        item.extraSettleMs=Math.min(90000,Math.max(0,Number(spec.settleMs)||0));
        await sleep(item.extraSettleMs);
      }
      if(spec.playSelector&&spec.controlAfterSettle){
        await clickControl();
        item.playAttempts.push(...await tryPlay(page));
        await sleep(2000);
      }
      if(item.mode==='late')await observe();
      let found=[];
      item.stage='discovery';
      for(let attempt=0;attempt<3;attempt++){
        found=await call('media:discover',{tabId:target.id});
        if(found.some(c=>!c.detectionOnly&&c.source&&c.duration>=(spec.minDuration??10)))break;
        if(attempt<2){await tryPlay(page);await sleep(2500);}
      }
      item.detected=found.some(c=>!c.detectionOnly);
      item.candidates=found.map(c=>({id:c.id,site:c.site,frameId:c.frameId,duration:c.duration,ad:c.ad,detectionOnly:!!c.detectionOnly,
        sourceStatus:c.sourceStatus,reason:c.sourceReason,media:c.detectedMedia,
        source:c.source?{kind:c.source.kind??'native',host:new URL(c.source.url).hostname,mime:c.source.mime??'',sabr:!!c.source.sabrRequest}:null}));
      item.nativeBeforePause=await nativeState(page);
      await nativeState(page,true);
      const candidate=found.filter(c=>!c.detectionOnly&&!c.ad&&c.source&&c.duration>=(spec.minDuration??10))
        .sort((a,b)=>b.width*b.height-a.width*a.height||b.duration-a.duration)[0];
      item.sourceSelected=!!candidate;
      if(candidate){
        item.stage='paused-ahead-decode';
        item.selectedCandidateId=candidate.id;
        await call('media:headers',{source:candidate.source});
        const asset=(await fs.readdir(path.join(extension,'assets'))).find(n=>/^decode-.*\.js$/.test(n));
        const duration=candidate.duration, length=Math.min(8,duration/4);
        const start=Math.min(3,duration/8), middle=Math.min(1180.15,Math.max(start+length+1,duration/2));
        for(const [begin,end] of [[start,start+length],[middle,Math.min(middle+length,duration-0.1)]]){
          if(end<=begin)continue;
          const before=await nativeState(page,true);
          const data=await decode(setup,asset,candidate.source,begin,end,candidate.duration);
          if(data.error)data.error=safeError(data.error);
          const after=await nativeState(page);
          const beforeVideo=before.flatMap(f=>f.videos).find(v=>v.id===candidate.id);
          const afterVideo=after.flatMap(f=>f.videos).find(v=>v.id===candidate.id);
          const stayedPaused=!!beforeVideo?.paused&&!!afterVideo?.paused&&Math.abs(afterVideo.time-beforeVideo.time)<0.1;
          const expected=Math.ceil((end-begin)*16000);
          const coverage=!!data.ok&&data.decodedStart<=begin+0.1&&data.decodedEnd>=end-0.1;
          item.windows.push({start:begin,end,...data,expectedSamples:expected,coverage,stayedPaused,
            passed:!!data.ok&&data.finitePCM&&data.samples===expected&&coverage&&stayedPaused});
          if(!data.ok)break;
        }
        await setup.evaluate(()=>{window.__auditDecoder?.terminate();delete window.__auditDecoder;});
      }
      item.aheadDecoded=item.windows.length>=2&&item.windows.every(w=>w.passed);
      item.stage='page-evidence';
      item.nativeAfter=await nativeState(page);
      item.mediaTraffic=mediaTraffic;
      item.drmObserved=item.nativeBeforePause.some(f=>f.encryptedEvents||f.videos.some(v=>v.protected));
      if(spec.inspectControls)item.playControls=await page.locator('button,[role="button"]').evaluateAll(items=>items.map(e=>({
        role:e.getAttribute('role')??e.tagName.toLowerCase(),
        label:(e.getAttribute('aria-label')??'').slice(0,120),
        title:(e.getAttribute('title')??'').slice(0,120),
        text:(e.textContent??'').trim().slice(0,120),
      })).filter(e=>e.label||e.title||e.text).slice(0,50)).catch(()=>[]);
      const body=item.title+'\n'+(await page.locator('body').innerText({timeout:4000}).catch(()=>'' )).slice(0,18000);
      item.pageSignals=[
        ['login',/请登录后观看|登录后继续观看|sign in to watch|log in to (?:watch|continue)|登录后即可观看/i],
        ['automation-check',/verify (?:you are human|to continue)|confirm (?:that )?you(?:'re| are) (?:a )?human|确认.{0,12}不是(?:聊天)?机器人|安全验证|captcha|not a bot|验证后继续/i],
        ['region',/not available in your country|所在地区.{0,20}(?:不支持|无法|不能)|not available in your (?:region|location)/i],
        ['unavailable',/视频已下架|视频已删除|video has been removed|video is no longer available|内容已被删除|video is unavailable/i],
        ['preview',/试看.{0,20}(?:结束|会员)|免费试看|preview (?:ended|only)|watch preview/i],
      ].flatMap(([kind,regex])=>{const match=body.match(regex);return match?[{kind,text:match[0].slice(0,80)}]:[];});
      const name=path.basename(reportFile,'.json')+'-'+String(index+1).padStart(2,'0')+'.png';
      item.screenshot='output/playwright/'+name;
      await page.screenshot({path:item.screenshot,fullPage:false,timeout:5000}).catch(()=>{delete item.screenshot;});
      item.stage='complete';
    }catch(error){item.error=safeError(error);}
    finally{
      clearTimeout(watchdog);
      item.elapsedSeconds=+( (Date.now()-started)/1000).toFixed(3);
      await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
      console.log(JSON.stringify({platform:item.platform,mode:item.mode,detected:item.detected,source:item.sourceSelected,ahead:item.aheadDecoded,error:item.error??null,elapsedSeconds:item.elapsedSeconds}));
      await context?.close().catch(()=>{});
      try{await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
      catch{item.cleanupWarning='Browser profile could not be completely removed; media result is retained.';await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');}
    }
  }
}finally{
  try{await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
  catch{report.cleanupWarning='Some isolated browser files remain under ignored work/; media results are retained.';await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');}
}
