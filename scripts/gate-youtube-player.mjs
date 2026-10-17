import { isolatedTestEnv } from './test-environment.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = await fs.mkdtemp(path.resolve('work/youtube-player-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
  env: isolatedTestEnv(),
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
});
const report = {
  at: new Date().toISOString(),
  scope:
    'Real Chrome extension, controlled YouTube DOM plus optional live watch page. No model calls.',
  checks: [],
};
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const call = (type, extra = {}) =>
    panel.evaluate(
      async ({ type, extra }) => {
        const r = await chrome.runtime.sendMessage({
          target: 'background',
          type,
          ...extra,
        });
        if (!r.ok) throw Error(r.error);
        return r.value;
      },
      { type, extra },
    );
  const fixture = 'https://www.youtube.com/watch?v=qvd-fixture-main';
  const embed = 'https://www.youtube.com/embed/qvd-fixture-main';
  await context.route(
    (url) => url.href === fixture || url.href === embed,
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `
    <title>YouTube player fixture</title>
    <div id="movie_player"><video id="hidden" class="html5-main-video" width="3840" height="2160" style="visibility:hidden;position:absolute"></video>
    <video id="main" class="html5-main-video" width="640" height="360"></video></div>
    <video id="preview" width="1920" height="1080"></video>
    ${route.request().url() === fixture ? `<iframe width="1280" height="720" src="${embed}"></iframe>` : ''}
    <script>window.ytInitialPlayerResponse={videoDetails:{videoId:'qvd-fixture-main',title:'Fixture'},streamingData:{adaptiveFormats:[]}};</script>`,
      }),
  );
  const page = await context.newPage();
  await page.goto(fixture);
  await page.waitForTimeout(1000);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    fixture,
  );
  let candidates = await call('media:discover', { tabId });
  assert.equal(candidates.length, 1, JSON.stringify(candidates));
  const first = candidates[0];
  assert.equal(first.frameId, 0);
  assert.equal(first.width, 640);
  const mainId = await page.locator('#main').getAttribute('data-qvd-id');
  assert.equal(first.id, mainId);
  report.checks.push(
    'Hidden 4K element, larger preview and duplicate embedded player collapse to one top-level main video',
  );
  await page.locator('#main').evaluate((v) => {
    v.width = 1280;
    v.height = 720;
  });
  candidates = await call('media:discover', { tabId });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, first.id);
  assert.equal(candidates[0].width, 1280);
  report.checks.push(
    'A resolution change updates dimensions while preserving the selected element identity',
  );
  await page.locator('#main').evaluate((v) => {
    const clone = v.cloneNode();
    clone.id = 'clone';
    clone.style.visibility = 'hidden';
    v.before(clone);
  });
  candidates = await call('media:discover', { tabId });
  assert.equal(candidates[0].id, first.id);
  const cloneId = await page.locator('#clone').getAttribute('data-qvd-id');
  assert.notEqual(cloneId, first.id);
  report.checks.push(
    'Cloning an element cannot steal the active player ID, even when inserted earlier in the DOM',
  );
  const attach = await panel.evaluate(
    async ({ tabId, candidate }) =>
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'player:attach',
          session: {
            id: 'controlled-ui',
            epoch: 0,
            candidate,
            language: 'zh',
            position: 0,
            phase: 'preparing',
            originalVolume: 0,
            dubVolume: 1,
            subtitles: false,
            readyThrough: 0,
          },
        },
        { frameId: 0 },
      ),
    { tabId, candidate: candidates[0] },
  );
  assert.equal(attach.ok, true);
  assert.equal(await page.locator('#main').evaluate((v) => v.muted), true);
  for (const selector of ['#hidden', '#clone', '#preview'])
    assert.equal(await page.locator(selector).evaluate((v) => v.muted), false);
  await panel.evaluate(
    async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'player:stop' }, { frameId: 0 }),
    tabId,
  );
  assert.equal(await page.locator('#main').evaluate((v) => v.muted), false);
  report.checks.push(
    'Control attaches to the main video only and restores it on stop; hidden and preview players remain untouched',
  );
  if (process.env.LIVE) {
    await page.goto('https://www.youtube.com/watch?v=zjkBMFhNj_g', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(8000);
    report.live = [];
    for (const level of ['hd720', 'hd1080', 'hd720']) {
      await page.evaluate((level) => {
        const p = document.querySelector('#movie_player');
        p?.setPlaybackQualityRange?.(level, level);
      }, level);
      await page.waitForTimeout(1500);
      const found = await call('media:discover', { tabId });
      report.live.push({
        requestedQuality: level,
        candidates: found.map((c) => ({
          id: c.id,
          frameId: c.frameId,
          width: c.width,
          height: c.height,
          sourceStatus: c.sourceStatus,
        })),
        actualQuality: await page.evaluate(() =>
          document.querySelector('#movie_player')?.getPlaybackQuality?.(),
        ),
      });
      assert.equal(found.length, 1, 'Live YouTube must expose one main player');
    }
    assert.equal(new Set(report.live.map((r) => r.candidates[0].id)).size, 1);
    report.checks.push(
      'Live YouTube watch page returns one stable control target across quality requests; actual applied qualities are recorded separately',
    );
  }
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack;
  throw e;
} finally {
  await fs.writeFile('outputs/youtube-player-verification.json', JSON.stringify(report, null, 2));
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
