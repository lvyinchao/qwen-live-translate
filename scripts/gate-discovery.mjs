import { isolatedTestEnv } from './test-environment.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = await fs.mkdtemp(path.resolve('work/discovery-gate-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
  env: isolatedTestEnv(),
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
const report = {
  at: new Date().toISOString(),
  scope:
    'Real Chrome extension with controlled Youku/iQIYI/Tencent-shaped pages; actual DOM/frame/network discovery; no site playback or model acceptance',
  checks: [],
  cases: [],
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
  const metadataFixture = JSON.stringify({
    vinfo: JSON.stringify({
      vl: {
        vi: [
          {
            vid: 'z4102cn0lk3',
            drm: 0,
            enc: '0',
            ul: {
              m3u8: '#EXTM3U\n#EXTINF:5,\nsegment.ts?token=keep\n#EXT-X-ENDLIST',
              ui: [{ url: 'https://ltscsy.qq.com/path/index.m3u8' }],
            },
          },
        ],
      },
    }),
  });
  const fixtures = {
    'https://v.qq.com/x/cover/cid/z4102cn0lk3.html':
      '<video width="640" height="360"></video><script>fetch("https://vd6.l.qq.com/proxyhttp");</script>',

    'https://v.youku.com/v_show/id_qvd_fixture.html':
      '<video width="640" height="360" src="https://cdn.youku.com/movie.mp4?signature=retain"></video>',
    'https://v.youku.com/v_show/id_qvd_late.html': '<div>Delayed player fixture</div>',
    'https://www.iqiyi.com/v_qvd_fixture.html':
      '<video width="640" height="360"></video><script>fetch("https://cdn.iqiyi.com/audio.m4a")</script>',
    'https://v.qq.com/x/cover/qvd-fixture.html':
      '<iframe src="https://player.qq.com/qvd-fixture" width="680" height="400"></iframe>',
    'https://player.qq.com/qvd-fixture':
      '<div id="shadow"></div><script>document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML=\'<video width="640" height="360" src="https://cdn.qq.com/episode.m3u8"></video>\'</script>',
  };
  await context.route('https://**/*', (route) => {
    const url = route.request().url();
    if (url === 'https://vd6.l.qq.com/proxyhttp')
      return route.fulfill({
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: metadataFixture,
      });
    if (fixtures[url])
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Discovery fixture</title>' + fixtures[url],
      });
    if (url === 'https://cdn.iqiyi.com/audio.m4a')
      return route.fulfill({
        contentType: 'audio/mp4',
        body: Buffer.from('discovery-only-media-response'),
      });
    return route.abort();
  });
  const page = await context.newPage();
  for (const [url, site, kind] of [
    ['https://v.youku.com/v_show/id_qvd_fixture.html', 'youku', 'file'],
    ['https://www.iqiyi.com/v_qvd_fixture.html', 'iqiyi', 'file'],
    ['https://v.qq.com/x/cover/qvd-fixture.html', 'tencent', 'hls'],
  ]) {
    await page.goto(url);
    await page.waitForTimeout(700);
    const tabId = await panel.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0].id,
      url,
    );
    const candidates = await call('media:discover', { tabId });
    assert.equal(candidates.length, 1, JSON.stringify(candidates));
    const c = candidates[0];
    assert.equal(c.site, site);
    assert.equal(c.sourceStatus, 'ready');
    assert.equal(c.source.kind, kind);
    assert.ok(c.source.url.startsWith('https://cdn.'));
    if (site === 'youku') assert.match(c.source.url, /signature=retain/);
    if (site === 'tencent') assert.notEqual(c.frameId, 0);
    const attached = await panel.evaluate(
      async ({ tabId, c }) =>
        chrome.tabs.sendMessage(
          tabId,
          {
            type: 'player:attach',
            session: {
              id: 'fixture',
              epoch: 0,
              candidate: c,
              position: 0,
              phase: 'preparing',
              originalVolume: 0,
              dubVolume: 1,
              subtitles: false,
              readyThrough: 0,
            },
          },
          { frameId: c.frameId },
        ),
      { tabId, c },
    );
    assert.equal(attached.ok, true);
    await page.waitForTimeout(400);
    const overlays = (
      await Promise.all(page.frames().map((f) => f.locator('[data-qvd-overlay]').count()))
    ).reduce((a, b) => a + b, 0);
    assert.equal(overlays, 1);
    await panel.evaluate(
      async ({ tabId, c }) =>
        chrome.tabs.sendMessage(tabId, { type: 'player:stop' }, { frameId: c.frameId }),
      { tabId, c },
    );
    report.cases.push({
      site,
      players: candidates.length,
      frameId: c.frameId,
      sourceKind: c.source.kind,
      detected: c.detectedMedia,
      overlayAttached: true,
    });
  }
  report.checks.push(
    'Youku/iQIYI/Tencent host detection, direct MP4, observed audio request and HLS source detection',
  );
  report.checks.push(
    'Nested frame and open shadow DOM video selection/control with stable frame identity',
  );
  await page.goto('https://v.youku.com/v_show/id_qvd_fixture.html');
  await page.evaluate(async () => {
    const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
      {
        initDataTypes: ['keyids'],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      },
    ]);
    await document.querySelector('video').setMediaKeys(await access.createMediaKeys());
  });
  const tabId = await panel.evaluate(
    async () =>
      (
        await chrome.tabs.query({
          url: 'https://v.youku.com/v_show/id_qvd_fixture.html',
        })
      )[0].id,
  );
  const [protectedVideo] = await call('media:discover', { tabId });
  assert.equal(protectedVideo.sourceStatus, 'unsupported');
  assert.equal(protectedVideo.source, undefined);
  assert.match(protectedVideo.sourceReason, /受保护/);
  report.checks.push(
    'A player with actual attached EME MediaKeys is identified as protected, never reported as ready',
  );
  await page.goto('https://www.iqiyi.com/v_qvd_fixture.html');
  await page.waitForTimeout(500);
  await page.locator('video').evaluate((v) => v.remove());
  const streamTab = await panel.evaluate(
    async () =>
      (
        await chrome.tabs.query({
          url: 'https://www.iqiyi.com/v_qvd_fixture.html',
        })
      )[0].id,
  );
  const streams = await call('media:discover', { tabId: streamTab });
  assert.ok(streams.some((c) => c.detectionOnly && c.detectedMedia?.[0]?.kind === 'file'));
  assert.ok(streams.every((c) => !c.source && c.sourceStatus === 'unsupported'));
  report.checks.push(
    'Network media remains discoverable without a DOM player, with an explicit unavailable-control status',
  );
  await page.goto('https://v.qq.com/x/cover/cid/z4102cn0lk3.html');
  await page.waitForTimeout(1200);
  const bridgeTab = await panel.evaluate(
    async () =>
      (
        await chrome.tabs.query({
          url: 'https://v.qq.com/x/cover/cid/z4102cn0lk3.html',
        })
      )[0].id,
  );
  const [inlineMedia] = await call('media:discover', { tabId: bridgeTab });
  assert.equal(inlineMedia.source?.kind, 'hls');
  assert.match(inlineMedia.source.hlsManifest, /token=keep/);
  report.checks.push(
    'Actual MAIN-world metadata observer, isolated bridge and background validation recover a Tencent inline HLS playlist from a fetch response',
  );
  // Delayed player insertion emits no media request: only continued scans
  // can update the already-open panel in this controlled case.
  await page.goto('https://v.youku.com/v_show/id_qvd_late.html');
  await panel.reload();
  await panel
    .getByText('Watching for audio. Available sources appear automatically.', {
      exact: true,
    })
    .waitFor();
  await page.bringToFront();
  await page.waitForTimeout(3500);
  assert.equal(await panel.locator('.video-choice').count(), 0);
  await page.evaluate(() => {
    const v = document.createElement('video');
    v.width = 640;
    v.height = 360;
    document.body.append(v);
  });
  await panel.locator('.video-choice').waitFor({ timeout: 6500 });
  assert.equal(await panel.getByRole('button', { name: /compatib/i }).count(), 0);
  report.checks.push(
    'An open panel discovers a delayed player automatically without a new network event or a manual rescan; no compatibility player entry remains',
  );
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack;
  throw e;
} finally {
  await fs.writeFile('outputs/discovery-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
}
