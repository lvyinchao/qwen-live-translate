import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const dir = await fs.mkdtemp(path.resolve('work/capture-gate-'));
const config = JSON.parse(
  await fs.readFile(path.join(os.homedir(), '.bailian/config.json'), 'utf8'),
);
const duration = Number(process.env.CAPTURE_SECONDS ?? 6);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=640x360:rate=30',
  '-stream_loop',
  '-1',
  '-f',
  's16le',
  '-ar',
  '16000',
  '-ac',
  '1',
  '-i',
  'tests/fixtures/probe.pcm',
  '-t',
  String(duration),
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-movflags',
  '+faststart',
  path.join(dir, 'fixture.mp4'),
]);
const movie = await fs.readFile(path.join(dir, 'fixture.mp4'));
const server = http.createServer((req, res) => {
  if (req.url === '/movie.mp4') {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': movie.length,
    });
    res.end(movie);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(
    '<html><title>Capture speech fixture</title><body style="margin:0;background:#121b24"><video controls playsinline width="640" height="360" src="/movie.mp4"></video></body></html>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await fs.cp('.output/chrome-mv3', path.join(dir, 'extension'), {
  recursive: true,
});
const context = await chromium.launchPersistentContext(
  path.join(dir, 'profile'),
  {
    channel: 'chromium',
    headless: !!process.env.HEADLESS,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: [
      '--enable-unsafe-extension-debugging',
      ...(process.env.NORMAL_AUTOPLAY
        ? []
        : ['--autoplay-policy=no-user-gesture-required']),
      '--no-proxy-server',
    ],
  },
);
const publicState = (s) => ({
  ...s,
  candidate: {
    title: s.candidate.title,
    site: s.candidate.site,
    currentTime: s.candidate.currentTime,
    duration: s.candidate.duration,
    protected: s.candidate.protected,
  },
});
let controlCall, sourcePage, viewerPage;
const report = {
  site: process.env.SITE_URL,
  autoplay: process.env.NORMAL_AUTOPLAY
    ? 'Chrome default policy'
    : 'test autoplay allowance',
  at: new Date().toISOString(),
  scope: process.env.SITE_URL
    ? 'Anonymous real Tencent page tabCapture with real Qwen voice translation; short segment only, not 20-minute acceptance'
    : 'Real Chrome tabCapture audio/video and real Qwen original-voice translation of a controlled speech video; not Tencent/iQIYI/Youku live-site acceptance',
  checks: [],
  errors: [],
};
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: path.join(dir, 'extension'),
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
  controlCall = call;
  await panel.evaluate((settings) => chrome.storage.local.set({ settings }), {
    apiKey: config.api_key,
    workspace: new URL(config.base_url).hostname.split('.')[0],
    region: 'cn-beijing',
    language: process.env.SITE_URL ? 'en' : 'zh',
    uiLanguage: 'en',
  });
  const source = await context.newPage();
  sourcePage = source;
  await source.goto(process.env.SITE_URL ?? `http://127.0.0.1:${port}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  if (process.env.SITE_URL) {
    await source.waitForTimeout(35000);
    await source.screenshot({ path: 'outputs/capture-site-source.png' });
  }
  if (process.env.NORMAL_AUTOPLAY && !process.env.SITE_URL) {
    await source.locator('video').first().click();
  }
  await source
    .locator('video')
    .first()
    .evaluate(async (v) => {
      await new Promise((r) =>
        v.readyState >= 2
          ? r()
          : Promise.race([
              new Promise((resolve) =>
                v.addEventListener('loadeddata', resolve, { once: true }),
              ),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(Error('Site video did not load.')),
                  20000,
                ),
              ),
            ]).then(r),
      );
      v.pause();
      v.volume = 0.6;
    });
  if (process.env.SITE_URL) {
    await source
      .locator('video')
      .first()
      .evaluate((v) => {
        v.currentTime = 300;
      });
    await source.waitForTimeout(2000);
    await source.screenshot({ path: 'outputs/capture-site-source.png' });
  }
  const target = (
    await root.send('Target.getTargets', { filter: [{ type: 'tab' }] })
  ).targetInfos.find((t) => t.url === source.url())?.targetId;
  assert.ok(target, 'Source tab target must be available.');
  await source.bringToFront();
  await root.send('Extensions.triggerAction', { id, targetId: target });
  console.log('Capture test activation', { id, target });
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    source.url(),
  );
  console.log('Capture source', tabId);
  const candidates = (await call('media:discover', { tabId })).sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );
  assert.ok(candidates[0]?.duration > 1);
  report.sourceDuration = candidates[0].duration;
  console.log('Starting actual tab capture');
  const t = Date.now();
  const start = await call('compat:start', {
    candidate: candidates[0],
    language: process.env.SITE_URL ? 'en' : 'zh',
  });
  report.sessionId = start.id;
  const progress = setInterval(
    () =>
      void call('compat:get')
        .then((s) => {
          if (s)
            console.log('Capture progress', {
              phase: s.phase,
              captured: s.capturedThrough,
              ready: s.readyThrough,
              paused: s.sourcePaused,
            });
        })
        .catch(() => {}),
    15000,
  );
  context.on('close', () => clearInterval(progress));
  const viewer =
    context.pages().find((p) => p.url().includes('viewer.html')) ??
    (await context.waitForEvent('page', {
      predicate: (p) => p.url().includes('viewer.html'),
    }));
  // windows.create may have emitted before compat:start resolved.
  const view =
    viewer ?? context.pages().find((p) => p.url().includes('viewer.html'));
  assert.ok(view);
  viewerPage = view;
  view.on('pageerror', (e) => report.errors.push(e.message));
  await view.waitForLoadState();
  await view.waitForFunction(
    () => !!document.querySelector('audio[data-role=translation]'),
    null,
    { timeout: 10000 },
  );
  await view.evaluate(() => {
    window.captureMetrics = [];
    const a = document.querySelector('audio[data-role=translation]');
    a.addEventListener('playing', () =>
      window.captureMetrics.push({
        videoTime: document.querySelector('video').currentTime,
        audioTime: a.currentTime,
        sourceStart: Number(a.dataset.sourceStart),
        sourceEnd: Number(a.dataset.sourceEnd),
        truncated: a.dataset.truncated === 'true',
        rate: a.playbackRate,
        at: performance.now(),
      }),
    );
  });
  await view.waitForFunction(
    () => {
      const v = document.querySelector('video');
      return v?.currentTime > 0.3 || document.querySelector('[role=alert]');
    },
    null,
    { timeout: 150000 },
  );
  report.firstWaitMs = Date.now() - t;
  report.state = publicState(await call('compat:get'));
  assert.notEqual(report.state.phase, 'error', report.state.error);
  assert.ok(report.state.readyThrough > 1, JSON.stringify(report.state));
  console.log('Translated buffer ready', report.firstWaitMs);
  if (
    process.env.NORMAL_AUTOPLAY &&
    (await view.locator('[role=alert]').count())
  )
    await view.getByRole('button', { name: 'Play', exact: true }).click();
  await view.waitForFunction(() => window.captureMetrics.length > 0, null, {
    timeout: 15000,
  });
  report.playback = await view.evaluate(() => ({
    video: document.querySelector('video').currentTime,
    originalVolume: document.querySelector('video').volume,
    dubVolume: document.querySelector('audio').volume,
    metrics: window.captureMetrics,
    caption: document.querySelector('.captions')?.textContent,
  }));
  assert.equal(report.playback.originalVolume, 0);
  report.checks.push(
    'Real tabCapture acquired both tracks; original source output is suppressed by Chrome.',
  );
  assert.ok(report.playback.metrics.length);
  report.checks.push(
    'Real translated WAV plays beside captured video on its media clock.',
  );
  await view.getByRole('checkbox', { name: 'Bilingual subtitles' }).uncheck();
  assert.equal(await view.locator('.captions').count(), 0);
  report.checks.push('Turning subtitles off removes the caption immediately.');
  await view.getByRole('button', { name: 'Pause', exact: true }).click();
  const pos = await view.locator('video').evaluate((v) => v.currentTime);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(
    Math.abs(
      (await view.locator('video').evaluate((v) => v.currentTime)) - pos,
    ) < 0.15,
  );
  report.checks.push('Pause stops the compatibility picture and translation.');
  if (process.env.BACKPRESSURE) {
    const deadline = Date.now() + 70000;
    while (Date.now() < deadline) {
      const s = await call('compat:get');
      if (s?.sourcePaused && s.capturedThrough > 85) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    report.backpressure = publicState(await call('compat:get'));
    assert.ok(
      report.backpressure.capturedThrough - report.backpressure.position < 94,
    );
    assert.equal(
      await source
        .locator('video')
        .first()
        .evaluate((v) => v.paused),
      true,
    );
    const before = await source
      .locator('video')
      .first()
      .evaluate((v) => v.currentTime);
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(
      Math.abs(
        (await source
          .locator('video')
          .first()
          .evaluate((v) => v.currentTime)) - before,
      ) < 0.05,
    );
    const readyDeadline = Date.now() + 45000;
    while (Date.now() < readyDeadline) {
      const s = await call('compat:get');
      if (s.readyThrough >= s.capturedThrough - 35) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ready = (await call('compat:get')).readyThrough;
    await view
      .locator('video')
      .evaluate(
        (v, pos) => (v.currentTime = pos),
        Math.min(ready - 3, report.backpressure.capturedThrough - 45),
      );
    const resumeDeadline = Date.now() + 20000;
    while (Date.now() < resumeDeadline) {
      const s = await call('compat:get');
      if (s && !s.sourcePaused) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal((await call('compat:get')).sourcePaused, false);
    report.checks.push(
      'Capture pauses the source at the buffer cap and resumes after seeking into prepared video; recorder pause excludes the waiting interval.',
    );
  }
  await view
    .getByRole('combobox', { name: 'Playback speed' })
    .selectOption('1.5');
  await view.getByRole('button', { name: 'Play', exact: true }).click();
  await new Promise((r) => setTimeout(r, 400));
  report.rate = await view.locator('video').evaluate((v) => v.playbackRate);
  assert.equal(report.rate, 1.5);
  await view.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  assert.ok(await view.evaluate(() => !!document.fullscreenElement));
  await view.evaluate(() => document.exitFullscreen());
  for (const width of [480, 1100]) {
    await view.setViewportSize({ width, height: 820 });
    assert.equal(
      await view.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await view.screenshot({
      path: `outputs/capture-${process.env.SITE_URL ? 'tencent-' : ''}player-${width}.png`,
    });
  }
  report.checks.push(
    '1.5x speed and fullscreen work; 480px and 1100px layouts do not overflow.',
  );
  await call('compat:stop');
  report.restored = await source
    .locator('video')
    .first()
    .evaluate((v) => ({
      muted: v.muted,
      volume: v.volume,
      rate: v.playbackRate,
      paused: v.paused,
    }));
  assert.deepEqual(report.restored, {
    muted: false,
    volume: 0.6,
    rate: 1,
    paused: true,
  });
  report.checks.push(
    'Stop restores source mute, volume, rate and original pause state.',
  );
  const rules = await panel.evaluate(() =>
    chrome.declarativeNetRequest.getSessionRules(),
  );
  assert.ok(!rules.some((r) => r.id === 910000));
  report.files = await call('files:status');
  report.checks.push(
    'Translated chunks persist locally and stop requests one merged result.',
  );
  report.metrics = await view.evaluate(() => window.captureMetrics);
  report.startErrorsMs = report.metrics
    .filter((m) => m.audioTime < 0.15 && !m.truncated)
    .map((m) => Math.abs(m.videoTime - m.sourceStart) * 1000);
  if (!process.env.SITE_URL && !process.env.BACKPRESSURE) {
    await source
      .locator('video')
      .first()
      .evaluate((v) => {
        v.pause();
        v.currentTime = 0;
      });
    const restarted = await call('compat:start', {
      candidate: candidates[0],
      language: 'zh',
    });
    assert.notEqual(restarted.id, start.id);
    await new Promise((r) => setTimeout(r, 2500));
    const next = await call('compat:get');
    assert.equal(next.phase, 'recording');
    assert.ok(next.chunks > 1);
    assert.equal(next.readyThrough, 0);
    const oldView = view;
    await oldView.close(); // Closing the old viewer must not stop the new capture.
    assert.equal((await call('compat:get')).id, restarted.id);
    await call('compat:stop');
    report.checks.push(
      'Restart gets a new recording epoch; closing the previous viewer leaves the new capture alive.',
    );
  }
  report.pass = true;
} catch (error) {
  if (controlCall)
    report.lastState = await controlCall('compat:get')
      .then((s) => (s ? publicState(s) : s))
      .catch(() => null);
  if (viewerPage) {
    report.viewer = await viewerPage
      .locator('body')
      .innerText()
      .catch(() => null);
    await viewerPage
      .screenshot({
        path: process.env.SITE_URL
          ? 'outputs/capture-tencent-failure.png'
          : 'outputs/capture-failure.png',
      })
      .catch(() => {});
  }
  if (sourcePage)
    report.source = await sourcePage
      .locator('video')
      .first()
      .evaluate((v) => ({
        time: v.currentTime,
        paused: v.paused,
        muted: v.muted,
        volume: v.volume,
        ready: v.readyState,
      }))
      .catch(() => null);
  report.error = String(error).replaceAll(config.api_key, '[redacted]');
  report.pass = false;
  console.error(report.error);
} finally {
  await fs.writeFile(
    process.env.SITE_URL
      ? 'outputs/capture-tencent-verification.json'
      : process.env.BACKPRESSURE
        ? 'outputs/capture-buffer-verification.json'
        : 'outputs/capture-verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, sessionId: undefined }, null, 2));
  await context.close();
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
}
if (!report.pass) process.exitCode = 1;
