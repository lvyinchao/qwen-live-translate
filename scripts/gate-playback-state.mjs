import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isolatedTestEnv } from './test-environment.mjs';

// An isolated Chromium profile and a synthetic page: no user account or model calls.
await fs.mkdir('work', { recursive: true });
await fs.mkdir('outputs', { recursive: true });
const extension = await fs.mkdtemp(path.resolve('work/playback-state-extension-'));
const profile = await fs.mkdtemp(path.resolve('work/playback-state-browser-'));
await fs.cp(path.resolve(process.env.EXTENSION_DIR ?? '.output/chrome-mv3'), extension, {
  recursive: true,
});
const context = await chromium.launchPersistentContext(profile, {
  env: isolatedTestEnv(),
  channel: 'chromium',
  headless: !!process.env.HEADLESS,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
const result = {
  at: new Date().toISOString(),
  scope: 'Actual built content script; synthetic local fixture; no live video or model acceptance',
  checks: [],
  errors: [],
};
try {
  context.setDefaultTimeout(10000);
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: extension });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await context.route('https://www.bilibili.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Playback state fixture</title><video data-qvd-id="fixture" style="width:640px;height:360px"></video>',
    }),
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => result.errors.push(error.message));
  await page.goto('https://www.bilibili.com/video/BV13rsaeaEgE/');
  const tabId = await panel.evaluate(
    async () => (await chrome.tabs.query({ url: 'https://www.bilibili.com/*' }))[0].id,
  );
  const send = (message) =>
    panel.evaluate(
      ({ tabId, message }) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      { tabId, message },
    );
  const session = {
    id: 'state-fixture',
    epoch: 5,
    languageVersion: 2,
    stateVersion: 10,
    candidate: {
      id: 'fixture',
      mediaId: 'bilibili:/video/BV13rsaeaEgE/:1',
      tabId,
      frameId: 0,
      site: 'bilibili',
      duration: 300,
      title: 'State fixture',
      sourceStatus: 'ready',
    },
    language: 'ja',
    position: 0,
    rate: 1,
    phase: 'buffering',
    readyThrough: 0,
    inputThrough: 0,
    skipped: 0,
    originalVolume: 0,
    dubVolume: 1,
    subtitles: true,
    segments: [],
  };
  const overlay = () => page.locator('[data-qvd-overlay]').count();
  const attach = await send({ type: 'player:attach', session });
  assert.equal(attach.ok, true);
  assert.equal(attach.rate, 1);
  assert.equal(await overlay(), 1);
  for (const old of [
    { ...session, epoch: 4 },
    { ...session, language: 'zh' },
    { ...session, epoch: 50, languageVersion: 1, language: 'zh' },
    { ...session, id: 'replaced-session', epoch: 100 },
    { ...session, stateVersion: 9 },
  ]) {
    const response = await send({ type: 'player:state', session: { ...old, phase: 'error' } });
    assert.equal(response.ok, false);
    assert.equal(await overlay(), 1);
  }
  result.checks.push(
    'Old seek, language, retried snapshot and replaced-session errors cannot destroy the current player',
  );
  assert.equal(
    (
      await send({
        type: 'player:state',
        session: { ...session, phase: 'paused', stateVersion: 11 },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await send({
        type: 'player:state',
        session: { ...session, phase: 'playing', stateVersion: 10 },
      })
    ).ok,
    false,
  );
  result.checks.push('A retried playing snapshot cannot override a newer pause in the same epoch');
  assert.equal((await send({ type: 'player:stop', sessionId: 'replaced-session' })).ok, false);
  assert.equal(await overlay(), 1);
  result.checks.push('A stale session-scoped stop cannot detach the new player');
  const oldAudio = await send({
    type: 'player:segment',
    epoch: 5,
    languageVersion: 1,
    segment: {
      id: 'old-audio',
      start: 0,
      end: 1,
      mediaId: session.candidate.mediaId,
      language: 'zh',
      voice: 'original-auto-v1',
      sourceText: '',
      text: '',
      audio: 'AAA=',
      audioDuration: 0.1,
    },
  });
  assert.equal(oldAudio.ok, false);
  const wrongMedia = await send({
    type: 'player:segment',
    epoch: 5,
    languageVersion: 2,
    segment: {
      id: 'wrong-media',
      start: 0,
      end: 1,
      mediaId: 'different-video',
      language: 'ja',
      voice: 'original-auto-v1',
      sourceText: '',
      text: '',
      audio: 'AAA=',
      audioDuration: 0.1,
    },
  });
  assert.equal(wrongMedia.ok, false);
  result.checks.push('Delivery ACK rejects old-language and wrong-video audio');
  const next = { ...session, language: 'zh', languageVersion: 3, epoch: 6 };
  assert.equal((await send({ type: 'player:language', session: next })).ok, true);
  const roundTrip = { ...next, language: 'ja', languageVersion: 4, epoch: 7 };
  assert.equal((await send({ type: 'player:language', session: roundTrip })).ok, true);
  assert.equal(
    (await send({ type: 'player:state', session: { ...session, phase: 'error' } })).ok,
    false,
  );
  assert.equal(await overlay(), 1);
  result.checks.push('Switching back to the same language retains language-version isolation');
  assert.equal(await page.locator('video').evaluate((video) => video.muted), true);
  assert.equal(
    (await send({ type: 'player:state', session: { ...roundTrip, phase: 'error' } })).ok,
    true,
  );
  assert.equal(await overlay(), 0);
  assert.equal(await page.locator('video').evaluate((video) => video.muted), false);
  result.checks.push(
    'A current terminal error detaches once and restores the original mute setting',
  );
  await context.route('https://video.example/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('.mp4') ? 'video/mp4' : 'text/html',
      body: route.request().url().endsWith('.mp4')
        ? Buffer.alloc(0)
        : '<!doctype html><video data-qvd-id="generic" src="/a.mp4" style="width:640px;height:360px"></video>',
    }),
  );
  const genericPage = await context.newPage();
  await genericPage.goto('https://video.example/watch');
  await genericPage.waitForFunction(() =>
    document.querySelector('video').currentSrc.endsWith('/a.mp4'),
  );
  const genericTab = await panel.evaluate(
    async () => (await chrome.tabs.query({ url: 'https://video.example/*' }))[0].id,
  );
  const attachedGeneric = await panel.evaluate(
    ({ tabId, session }) =>
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'player:attach',
          session: {
            ...session,
            id: 'generic-task',
            candidate: {
              ...session.candidate,
              id: 'generic',
              tabId,
              site: 'generic',
              mediaId: 'generic-source',
              frameMediaId: 'https://video.example/watch',
            },
          },
        },
        { frameId: 0 },
      ),
    { tabId: genericTab, session },
  );
  assert.equal(attachedGeneric.ok, true);
  assert.equal(await genericPage.locator('[data-qvd-overlay]').count(), 1);
  await genericPage.locator('video').evaluate((video) => {
    video.src = '/b.mp4';
  });
  await genericPage.waitForFunction(() => !document.querySelector('[data-qvd-overlay]'));
  assert.equal(await genericPage.locator('video').evaluate((video) => video.muted), false);
  result.checks.push(
    'Changing the src of a reused generic video element detaches old translation and restores the original volume',
  );
  assert.deepEqual(result.errors, []);
} finally {
  await context.close();
  await fs.rm(extension, { recursive: true, force: true });
  await fs.rm(profile, { recursive: true, force: true });
  await fs.writeFile(
    'outputs/playback-state-verification.json',
    JSON.stringify(result, null, 2) + '\n',
  );
}
console.log(JSON.stringify(result));
