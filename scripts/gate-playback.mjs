import os from 'node:os';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const cfg = JSON.parse(
  await fs.readFile(
    process.env.BAILIAN_CONFIG ??
      path.join(os.homedir(), '.bailian/config.json'),
    'utf8',
  ),
);
const host = new URL(cfg.base_url).hostname;
const workspace = host.split('.')[0],
  region = host.split('.')[1];
const extension = await fs.mkdtemp(path.resolve('work/extension-snapshot-'));
await fs.cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
const c = await chromium.launchPersistentContext(
  await fs.mkdtemp(path.resolve('work/playback-browser-')),
  {
    channel: 'chromium',
    headless: !!process.env.HEADLESS,
    timeout: 25000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      ...(process.env.NORMAL_POLICY
        ? []
        : ['--autoplay-policy=no-user-gesture-required']),
    ],
  },
);
let call, panel, p;
const report = {
  at: new Date().toISOString(),
  normalPolicy: !!process.env.NORMAL_POLICY,
  headless: !!process.env.HEADLESS,
  url: process.env.VIDEO_URL ?? 'https://www.bilibili.com/video/BV13rsaeaEgE/',
  actions: [],
  snapshots: [],
};
try {
  const root = await c.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  panel = await c.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  call = (type, params = {}) =>
    panel.evaluate(
      async ({ type, params }) => {
        const r = await chrome.runtime.sendMessage({
          target: 'background',
          type,
          ...params,
        });
        if (!r.ok) throw new Error(r.error);
        return r.value;
      },
      { type, params },
    );
  await call('settings:save', {
    settings: {
      apiKey: cfg.api_key,
      workspace,
      region,
      language: process.env.TARGET_LANGUAGE ?? 'zh',
    },
  });
  p = await c.newPage();
  await p.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(6000);
  if (process.env.NORMAL_POLICY)
    await p.locator('video').first().click({ force: true });
  await p
    .locator('video')
    .first()
    .evaluate((v) => {
      v.muted = true;
      v.volume = 0.35;
      void v.play();
    });
  await p.waitForTimeout(report.url.includes('youtube') ? 1000 : 5000);
  const autoplay = p.locator('.ytp-autonav-toggle-button[aria-checked="true"]');
  if (await autoplay.count())
    await autoplay
      .first()
      .click({ timeout: 500 })
      .catch(() => {});
  for (
    let i = 0;
    i < 120 && (await p.locator('#movie_player.ad-showing').count());
    i++
  ) {
    const skip = p.locator('.ytp-skip-ad-button,.ytp-ad-skip-button-modern');
    if (await skip.count())
      await skip
        .first()
        .click({ timeout: 500 })
        .catch(() => {});
    await p.waitForTimeout(500);
  }
  await p
    .locator('video')
    .first()
    .evaluate((v) => {
      v.pause();
      v.currentTime = 0;
    });
  await p.waitForTimeout(700);
  const tab = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url),
    report.url,
  );
  const candidates = await call('media:discover', { tabId: tab.id });
  const candidate = candidates[0];
  if (!candidate?.source) throw new Error('no prefetchable source');
  const t = Date.now();
  await call('session:start', {
    candidate,
    language: process.env.TARGET_LANGUAGE ?? 'zh',
  });
  let s;
  for (let i = 0; i < 180; i++) {
    await p.waitForTimeout(500);
    s = await call('session:get');
    if (!s) throw new Error('session disappeared');
    if (s.phase === 'error') throw new Error(s.error);
    if (i % 10 === 0)
      console.log(
        'startup',
        JSON.stringify({
          phase: s.phase,
          input: s.inputThrough,
          ready: s.readyThrough,
          segments: s.segments.length,
        }),
      );
    if (s.phase === 'playing') break;
  }
  if (s.phase !== 'playing') throw new Error('startup timeout');
  report.firstReadyMs = Date.now() - t;
  console.log('ready', report.firstReadyMs);
  if (process.env.RESTART_WORKER) {
    const debug = await c.newCDPSession(panel);
    let version;
    const workerStates = [];
    debug.on('ServiceWorker.workerVersionUpdated', (e) => {
      workerStates.push(
        ...e.versions
          .filter(
            (v) => v.scriptURL === `chrome-extension://${id}/background.js`,
          )
          .map((v) => v.runningStatus),
      );
      version =
        e.versions.find(
          (v) => v.scriptURL === `chrome-extension://${id}/background.js`,
        )?.versionId ?? version;
    });
    await debug.send('ServiceWorker.enable');
    await p.waitForTimeout(500);
    if (!version)
      throw new Error(
        'Could not locate the extension worker for restart verification',
      );
    const oldWorker = c.serviceWorkers().find((w) => w.url().includes(id));
    let closed = false;
    oldWorker?.on('close', () => {
      closed = true;
    });
    await debug.send('ServiceWorker.stopWorker', { versionId: version });
    await p.waitForTimeout(700);
    const resumed = await call('session:get');
    report.actions.push({
      workerRestart: closed || workerStates.includes('stopped'),
      workerStates,
      sameSession: resumed?.id === s.id,
    });
    if (resumed?.id !== s.id)
      throw new Error('Worker restart lost the playback session');
    await debug.detach();
  }
  await p.waitForTimeout(12000);
  const initial = await call('session:get');
  report.snapshots.push({
    kind: 'initial',
    position: initial.position,
    phase: initial.phase,
    segments: initial.segments.length,
  });
  await p
    .locator('video')
    .first()
    .evaluate((v) => v.pause());
  await p.waitForTimeout(1500);
  const pausedPhase = (await call('session:get')).phase;
  report.actions.push({ pause: pausedPhase });
  if (pausedPhase !== 'paused') throw new Error('Pause did not synchronize');
  await p
    .locator('video')
    .first()
    .evaluate((v) => v.play());
  await p.waitForTimeout(2000);
  await p
    .locator('video')
    .first()
    .evaluate((v) => {
      v.playbackRate = 1.5;
    });
  await p.waitForTimeout(8000);
  const playbackSpeed = (await call('session:get')).rate;
  report.actions.push({ speed: playbackSpeed });
  if (playbackSpeed !== 1.5)
    throw new Error('Playback speed did not synchronize');
  await call('session:mix', {
    originalVolume: 0.1,
    dubVolume: 0.8,
    subtitles: true,
  });
  await p.waitForTimeout(1000);
  report.actions.push({
    mix: await p
      .locator('video')
      .first()
      .evaluate((v) => ({ muted: v.muted, volume: v.volume })),
  });
  const sourceMix = report.actions.at(-1).mix;
  if (sourceMix?.muted || Math.abs(sourceMix?.volume - 0.1) > 0.001)
    throw new Error('Original volume was overwritten');
  await call('session:mix', {
    originalVolume: 0,
    dubVolume: 1,
    subtitles: true,
  });
  for (const position of process.env.LONG_RUN ? [] : [120, 5, 125]) {
    const beforeEpoch = (await call('session:get')).epoch;
    await p
      .locator('video')
      .first()
      .evaluate((v, position) => {
        v.currentTime = position;
      }, position);
    await p.waitForTimeout(600);
    let s;
    const at = Date.now();
    for (let i = 0; i < 150; i++) {
      s = await call('session:get');
      if (s?.phase === 'error') throw new Error(s.error);
      if (
        s?.phase === 'playing' &&
        s.epoch > beforeEpoch &&
        Math.abs(s.position - position) < 3
      )
        break;
      await p.waitForTimeout(500);
    }
    if (
      s?.phase !== 'playing' ||
      s.epoch <= beforeEpoch ||
      Math.abs(s.position - position) >= 3
    )
      throw new Error('Seek did not become ready in the expected generation');
    report.actions.push({
      seek: position,
      phase: s?.phase,
      epoch: s?.epoch,
      waitMs: Date.now() - at,
    });
    await p.waitForTimeout(3000);
  }
  if (process.env.RAPID_SEEKS) {
    for (const position of [70, 160, 20]) {
      await p
        .locator('video')
        .first()
        .evaluate((v, t) => {
          v.currentTime = t;
        }, position);
      await p.waitForTimeout(80);
    }
    await p.waitForTimeout(900);
    const state = await call('session:get');
    report.actions.push({
      rapidSeekFinal: state?.position,
      phase: state?.phase,
      epoch: state?.epoch,
    });
    if (!state || state.phase === 'error' || Math.abs(state.position - 20) > 3)
      throw new Error('Rapid seek isolation failed');
  }
  if (process.env.LONG_RUN) {
    await p
      .locator('video')
      .first()
      .evaluate((v) => {
        v.playbackRate = 1;
      });
    const started = Date.now(),
      sourceStart = (await call('session:get')).position;
    report.memorySamples = [];
    for (let i = 0; ; i++) {
      if (Date.now() - started > Number(process.env.LONG_RUN) * 2000)
        throw new Error(
          '20 minute source-time run exceeded the wall-time limit',
        );
      await p.waitForTimeout(report.url.includes('youtube') ? 1000 : 5000);
      const state = await call('session:get');
      if (!state) throw new Error('session disappeared');
      if (state.phase === 'error') throw new Error(state.error);
      if (state.phase === 'ended')
        throw new Error('Video ended before 20 minute acceptance');
      report.snapshots.push({
        at: Date.now(),
        position: state.position,
        phase: state.phase,
        ready: state.readyThrough,
        segments: state.segments.length,
        skipped: state.skipped,
      });
      if (i % 12 === 0) {
        const processInfo = (await root.send('SystemInfo.getProcessInfo'))
          .processInfo;
        const rss = execFileSync(
          'ps',
          ['-o', 'rss=', '-p', processInfo.map((p) => p.id).join(',')],
          { encoding: 'utf8' },
        )
          .trim()
          .split(/\s+/)
          .map(Number)
          .reduce((n, v) => n + v, 0);
        const d = await call('session:diagnostics');
        report.memorySamples.push({
          at: Date.now(),
          browserRssMiB: rss / 1024,
          extensionHeap: d.value?.heap,
          cacheBytes: d.value?.cacheBytes,
        });
        await fs.writeFile(
          'work/playback-progress.json',
          JSON.stringify(report, null, 2),
        );
        console.log('progress', JSON.stringify(report.snapshots.at(-1)));
      }
      if (state.position - sourceStart >= Number(process.env.LONG_RUN)) {
        report.continuousSourceSeconds = state.position - sourceStart;
        break;
      }
    }
    report.continuousWallSeconds = (Date.now() - started) / 1000;
  }
  const fullscreen = await p
    .locator('.bpx-player-ctrl-full,.ytp-fullscreen-button')
    .count();
  if (fullscreen) {
    await p
      .locator('.bpx-player-ctrl-full,.ytp-fullscreen-button')
      .last()
      .click({ force: true, timeout: 2000 })
      .catch(() => {});
    await p.waitForTimeout(1000);
    report.actions.push({
      fullscreen: await p.evaluate(() => !!document.fullscreenElement),
    });
    await p.keyboard.press('Escape');
  }
  const state = await call('session:get');
  report.final = {
    phase: state.phase,
    position: state.position,
    segments: state.segments.length,
    skipped: state.skipped,
    transcripts: state.segments.slice(0, 3),
  };
  report.diagnostics = await call('session:diagnostics');
  await p.screenshot({ path: 'outputs/真实视频译音.png' });
  await call('session:stop');
  report.restored = await p
    .locator('video')
    .first()
    .evaluate((v) => ({ muted: v.muted, volume: v.volume }));
  report.rulesAfterStop = await panel.evaluate(
    async () => (await chrome.declarativeNetRequest.getSessionRules()).length,
  );
  if (report.rulesAfterStop !== 0)
    throw new Error('Temporary rules remain after stop');
  if (
    report.restored?.muted !== true ||
    Math.abs(report.restored?.volume - 0.35) > 0.001
  )
    throw new Error('Original sound was not restored');
  report.ok = true;
} catch (e) {
  report.ok = false;
  if (call) {
    try {
      const s = await call('session:get');
      report.failureState = s
        ? {
            phase: s.phase,
            position: s.position,
            inputThrough: s.inputThrough,
            readyThrough: s.readyThrough,
            segments: s.segments.length,
            epoch: s.epoch,
          }
        : null;
      report.diagnostics = await call('session:diagnostics');
      if (s?.phase === 'error' && p) {
        await p.waitForTimeout(500);
        report.restoredAfterError = await p
          .locator('video')
          .first()
          .evaluate(async (v) => {
            const before = { muted: v.muted, volume: v.volume };
            try {
              await Promise.race([
                v.play(),
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        new Error('Native playback wait exceeded 2 seconds'),
                      ),
                    2000,
                  ),
                ),
              ]);
              return { ...before, canPlay: !v.paused };
            } catch (e) {
              return { ...before, playError: e.message };
            }
          });
        report.rulesAfterError = await panel.evaluate(
          async () =>
            (await chrome.declarativeNetRequest.getSessionRules()).length,
        );
      }
      await call('session:stop');
    } catch {}
  }
  report.error = e.message
    .replace(/sk-[\w-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s]+\?[^\s]+/g, '[media url]');
  console.log('failed', report.error);
} finally {
  await fs.writeFile(
    process.env.PLAYBACK_REPORT ?? 'work/gate-playback.json',
    JSON.stringify(report, null, 2),
  );
  await c.close();
}
