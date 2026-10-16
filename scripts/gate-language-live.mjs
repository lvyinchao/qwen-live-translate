import { isolatedTestEnv } from './test-environment.mjs';
import os from 'node:os';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
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

const directory = await fs.mkdtemp(path.resolve('work/language-live-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const context = await chromium.launchPersistentContext(
  path.join(directory, 'profile'),
  {
    env: isolatedTestEnv(),
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
);
const report = {
  at: new Date().toISOString(),
  url: 'https://www.bilibili.com/video/BV13rsaeaEgE/',
  scope:
    'Live Bilibili native player and actual Qwen3.8 original-voice sessions. Chinese target switched to Japanese during playback. Short software playback check only; not long-video/hardware synchronization acceptance.',
  snapshots: [],
};
let call;
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  call = (type, params = {}) =>
    panel.evaluate(
      async ({ type, params }) => {
        const r = await chrome.runtime.sendMessage({
          target: 'background',
          type,
          ...params,
        });
        if (!r.ok) throw Error(r.error);
        return r.value;
      },
      { type, params },
    );
  await call('settings:save', {
    settings: { apiKey: cfg.api_key, workspace, region, language: 'zh' },
  });
  const page = await context.newPage();
  await page.goto(report.url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(15000);
  await page
    .locator('video')
    .first()
    .evaluate(async (v) => {
      v.muted = true;
      v.volume = 0.35;
      await v.play();
    });
  await page.waitForTimeout(4000);
  await page
    .locator('video')
    .first()
    .evaluate((v) => {
      v.pause();
      v.currentTime = 0;
    });
  await page.waitForTimeout(500);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    report.url,
  );
  const [candidate] = await call('media:discover', { tabId });
  assert.ok(candidate.source);
  report.source = {
    mime: candidate.source.mime,
    host: new URL(candidate.source.url).hostname,
    path: new URL(candidate.source.url).pathname.split('/').pop(),
    duration: candidate.duration,
    trackId: candidate.source.trackId,
  };
  async function ready(language) {
    const start = Date.now();
    while (Date.now() - start < 100000) {
      const s = await call('session:get');
      if (!s || s.phase === 'error')
        throw Error(s?.error ?? 'Session disappeared');
      if (s.language === language && s.phase === 'playing' && s.segments.length)
        return { session: s, waitMs: Date.now() - start };
      await page.waitForTimeout(500);
    }
    throw Error('Timed out preparing ' + language);
  }
  await call('session:start', { candidate, language: 'zh' });
  let current = await ready('zh');
  report.snapshots.push({
    language: 'zh',
    waitMs: current.waitMs,
    position: current.session.position,
    epoch: current.session.epoch,
    segments: current.session.segments.map(({ start, end, text }) => ({
      start,
      end,
      text,
    })),
  });
  await page.waitForTimeout(2000);
  report.switchAt = await page
    .locator('video')
    .first()
    .evaluate((v) => v.currentTime);
  await panel.locator('#language').selectOption('ja');
  current = await ready('ja');
  report.snapshots.push({
    language: 'ja',
    waitMs: current.waitMs,
    position: current.session.position,
    epoch: current.session.epoch,
    segments: current.session.segments.map(({ start, end, text }) => ({
      start,
      end,
      text,
    })),
  });
  assert.equal(current.session.id, (await call('session:get')).id);
  assert.ok(current.session.epoch > report.snapshots[0].epoch);
  assert.ok(
    current.session.segments.some((s) => /[ぁ-んァ-ン]/.test(s.text)),
    'Japanese transcript must contain actual Japanese',
  );
  assert.ok(
    current.session.segments.every((s) => s.start >= report.switchAt - 0.5),
  );
  await page.waitForTimeout(6000);
  const response = await call('session:diagnostics');
  const diagnostics = response.value ?? response;
  report.japaneseAudioStarts = diagnostics.events
    .filter((e) => e.kind === 'start' && e.epoch === current.session.epoch)
    .map(({ mediaTime, error, rate, partial }) => ({
      mediaTime,
      error,
      rate,
      partial,
    }));
  assert.ok(
    report.japaneseAudioStarts.length,
    'Actual translated audio must emit playing in the native player',
  );
  report.after = await page
    .locator('video')
    .first()
    .evaluate((v) => ({
      position: v.currentTime,
      paused: v.paused,
      muted: v.muted,
    }));
  assert.equal(report.after.paused, false);
  assert.ok(report.after.position > report.switchAt + 3);
  assert.equal((await call('settings:get')).autoSaveFiles, false);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    0,
  );
  await call('session:stop');
  report.rulesAfterStop = (
    await panel.evaluate(() => chrome.declarativeNetRequest.getSessionRules())
  ).length;
  assert.equal(report.rulesAfterStop, 0);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.message;
  if (call)
    report.diagnostics = await call('session:diagnostics')
      .then((r) => r.value ?? r)
      .catch(() => null);
  throw e;
} finally {
  if (call) await call('session:stop').catch(() => {});
  await fs.writeFile(
    'outputs/language-live-verification.json',
    JSON.stringify(report, null, 2),
  );
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
