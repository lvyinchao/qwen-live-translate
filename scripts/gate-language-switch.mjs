import { isolatedTestEnv } from './test-environment.mjs';
import { syntheticWav } from '../tests/fixtures/audio.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const directory = await fs.mkdtemp(path.resolve('work/language-switch-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const media = path.join(directory, 'fixture.mp4');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=320x180:r=5:d=90',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=16000:cl=mono',
  '-t',
  '90',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  '-movflags',
  '+faststart',
  media,
]);
const bytes = await fs.readFile(media);
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
  scope:
    'Real extension/background/offscreen/player in isolated Chrome; cached language fixtures use generated synthetic tones. No provider calls, recordings or language quality claim.',
  checks: [],
};
const poll = async (fn, description, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timeout: ' + description);
};
try {
  // Fixture routes below override this default deny rule. Never contact real sites/models.
  await context.route(/^https?:/, (route) => route.abort('blockedbyclient'));
  await context.routeWebSocket(/^wss?:/, (socket) =>
    socket.close({
      code: 1000,
      reason: 'Offline test: no external WebSockets',
    }),
  );
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const call = (type, params = {}) =>
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
      apiKey: 'fixture-key-never-sent',
      workspace: 'test-workspace',
      region: 'cn-beijing',
      language: 'zh',
    },
  });
  const fixture = 'https://example.com/qvd-language-switch';
  const mediaUrl = 'https://example.com/fixture.mp4';
  await context.route(fixture, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<title>Language switch fixture</title><video width="640" height="360" src="/fixture.mp4" controls></video>',
    }),
  );
  await context.route(mediaUrl, async (r) => {
    const match = /bytes=(\d+)-(\d*)/.exec(r.request().headers().range ?? '');
    const start = Number(match?.[1] ?? 0),
      end = Math.min(Number(match?.[2] || bytes.length - 1), bytes.length - 1);
    await r.fulfill({
      status: match ? 206 : 200,
      contentType: 'video/mp4',
      headers: {
        'accept-ranges': 'bytes',
        ...(match
          ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
      body: bytes.subarray(start, end + 1),
    });
  });
  // Prevent an uncached case from making an accidental paid provider request.
  await context.routeWebSocket(/(?:maas\.aliyuncs\.com|dashscope)/, (socket) =>
    socket.close({ code: 1000, reason: 'Fixture: no provider calls' }),
  );
  const page = await context.newPage();
  await page.goto(fixture);
  await page.waitForFunction(
    () => Math.abs(document.querySelector('video').duration - 90) < 0.1,
  );
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    fixture,
  );
  const candidate = (await call('media:discover', { tabId }))[0];
  assert.ok(candidate.source, JSON.stringify(candidate));
  const wav = syntheticWav().toString('base64');
  await panel.evaluate(
    async ({ candidate, wav }) => {
      const request = indexedDB.open('qwen-video-dub', 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('windows', { keyPath: 'key' });
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      const db = await new Promise((r, j) => {
        request.onsuccess = () => r(request.result);
        request.onerror = () => j(request.error);
      });
      const tx = db.transaction(['windows', 'metadata'], 'readwrite');
      for (const language of ['zh', 'en', 'ja']) {
        const voice = 'original-auto-v1',
          mediaId = candidate.mediaId + '|audio:default';
        const segments = Array.from({ length: 30 }, (_, i) => ({
          id: `${language}-${i}`,
          mediaId: candidate.mediaId,
          language,
          voice,
          start: i * 3,
          end: i * 3 + 3,
          audio: wav,
          audioDuration: 3.84,
          text: `TARGET-${language}-${i}`,
          sourceText: 'SOURCE',
          speaker: 0,
        }));
        const row = {
          key: JSON.stringify([mediaId, language, voice, 0, 90]),
          mediaId,
          language,
          voice,
          start: 0,
          end: 90,
          touched: Date.now(),
          bytes: wav.length * 30,
        };
        tx.objectStore('windows').put({ ...row, segments });
        tx.objectStore('metadata').put(row);
      }
      await new Promise((r, j) => {
        tx.oncomplete = r;
        tx.onerror = () => j(tx.error);
      });
      db.close();
    },
    { candidate, wav },
  );
  await page.locator('video').evaluate(async (v) => {
    v.muted = false;
    v.volume = 0.65;
    v.currentTime = 23;
    v.playbackRate = 1.5;
    await v.play();
  });
  await call('session:start', { candidate, language: 'zh' });
  await poll(
    async () => (await call('session:get'))?.phase === 'playing',
    'initial cache playback',
  );
  await call('session:mix', {
    originalVolume: 0.12,
    dubVolume: 0.7,
    subtitles: false,
  });
  const sourceClock = () => page.locator('video').evaluate((v) => ({
    position: v.currentTime, at: performance.now(), rate: v.playbackRate,
  }));
  const before = await sourceClock();
  await panel.locator('#language').selectOption('en');
  const afterAction = await sourceClock();
  const active = await poll(async () => {
    const s = await call('session:get');
    return (
      s?.language === 'en' && s.phase === 'playing' && s.segments.length && s
    );
  }, 'English cache playback');
  const afterReady = await sourceClock();
  // A playing 1.5x source can legitimately advance while UI and cache messages
  // are processed. Bound real media-clock progress by elapsed time rather than
  // misclassifying a slow browser action as a seek after a fixed one-second gap.
  for (const [previous, next] of [[before, afterAction], [afterAction, afterReady]]) {
    const elapsed = (next.at - previous.at) / 1000;
    const advance = next.position - previous.position;
    assert.ok(advance >= -0.05 && advance <= elapsed * Math.max(previous.rate, next.rate) + 0.05,
      `source clock jumped ${advance}s over ${elapsed}s at ${previous.rate}x/${next.rate}x`);
  }
  assert.ok(active.position >= before.position - 0.05 && active.position <= afterReady.position + 0.05,
    `switch position ${active.position} outside observed source interval ${before.position}–${afterReady.position}`);
  report.activeSwitchClock = { before, afterAction, afterReady, readyPosition: active.position };
  assert.equal(active.rate, 1.5);
  assert.equal(active.originalVolume, 0.12);
  assert.equal(active.dubVolume, 0.7);
  assert.equal(active.subtitles, false);
  assert.ok(active.segments.every((s) => s.text.startsWith('TARGET-en-')));
  report.checks.push(
    'Enabled language selector switches active cached Chinese→English at actual current video time, preserving 1.5× playback, both volume settings and hidden subtitles',
  );
  const cdp = await context.newCDPSession(page);
  const playerSnapshot = async () => {
    const { root } = await cdp.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    });
    let host;
    const walk = (n) => {
      if ((n.attributes ?? []).includes('data-qvd-overlay')) host = n;
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])])
        walk(c);
    };
    walk(root);
    assert.ok(host);
    const { object } = await cdp.send('DOM.resolveNode', {
      nodeId: host.nodeId,
    });
    // Resolve the closed shadow root itself for access to its audio/caption.
    const shadow = host.shadowRoots[0];
    const resolved = await cdp.send('DOM.resolveNode', {
      nodeId: shadow.nodeId,
    });
    const snapshot = await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration:
        'function(){const a=this.querySelector("audio"),c=this.querySelector(".caption");const shown=(selector)=>{const e=c.querySelector(selector);return !!e&&e.getBoundingClientRect().height>0&&getComputedStyle(e).display!=="none";};return {caption:c.textContent,hidden:c.hidden,sourceVisible:shown(".source"),targetVisible:shown(".target"),src:a.getAttribute("src"),paused:a.paused}}',
      returnByValue: true,
    });
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
    await cdp.send('Runtime.releaseObject', {
      objectId: resolved.object.objectId,
    });
    return snapshot.result.value;
  };
  await poll(
    async () => (await playerSnapshot()).caption.includes('TARGET-en-'),
    'English player captions',
  );
  assert.equal((await playerSnapshot()).hidden, true);
  const originalSwitch = panel.getByLabel('Show original-language subtitles', { exact: true });
  const targetSwitch = panel.getByLabel('Show target-language subtitles', { exact: true });
  for (const [sourceSubtitles, targetSubtitles] of [[true,true],[false,true],[false,false],[true,false]]) {
    await originalSwitch.setChecked(sourceSubtitles);
    await targetSwitch.setChecked(targetSubtitles);
    await poll(async () => {
      const s = await call('session:get'), v = await playerSnapshot();
      return s.sourceSubtitles === sourceSubtitles && s.targetSubtitles === targetSubtitles &&
        v.sourceVisible === sourceSubtitles && v.targetVisible === targetSubtitles;
    }, `subtitle switches ${sourceSubtitles}/${targetSubtitles}`);
  }
  report.checks.push('Actual sidepanel switches immediately select original only, target only, both or neither in the running webpage, and engine progress preserves each choice');
  // A response from the old language must fail both progress and audio checks.
  const old = { ...active, language: 'zh', epoch: active.epoch + 50 };
  await call('engine:state', { session: old });
  assert.equal((await call('session:get')).language, 'en');
  assert.equal(
    await call('engine:segment', {
      sessionId: active.id,
      epoch: active.epoch,
      segment: {
        ...active.segments[0],
        language: 'zh',
        text: 'STALE-CHINESE',
        audio: wav,
        audioDuration: 3.84,
      },
    }),
    false,
  );
  assert.ok(!(await playerSnapshot()).caption.includes('STALE'));
  report.checks.push(
    'Delayed old-language state and segments are rejected, even with a misleading newer epoch; actual closed-shadow player stays on the selected language',
  );
  await page.locator('video').evaluate((v) => v.pause());
  await poll(
    async () => (await call('session:get')).phase === 'paused',
    'user pause',
  );
  const pausedAt = await page.locator('video').evaluate((v) => v.currentTime);
  await panel.locator('#language').selectOption('ja');
  await poll(async () => {
    const s = await call('session:get');
    return s.language === 'ja' && s.phase === 'paused';
  }, 'paused Japanese switch');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.locator('video').evaluate((v) => v.paused), true);
  assert.ok(
    Math.abs(
      (await page.locator('video').evaluate((v) => v.currentTime)) - pausedAt,
    ) < 0.05,
  );
  const captionChoice = await call('session:get');
  assert.equal(captionChoice.sourceSubtitles, true);
  assert.equal(captionChoice.targetSubtitles, false);
  await poll(async () => { const v = await playerSnapshot(); return v.sourceVisible && !v.targetVisible; }, 'caption choice after target language switch');
  const pausedSession = await call('session:get');
  await panel.evaluate(async (s) => {
    const replies = await Promise.all([
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'player:seek',
        sessionId: s.id,
        epoch: s.epoch,
        languageVersion: s.languageVersion,
        position: s.position,
        paused: true,
      }),
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'session:language',
        sessionId: s.id,
        language: 'zh',
      }),
    ]);
    for (const r of replies) if (!r.ok) throw Error(r.error);
  }, pausedSession);
  const afterSeekSwitch = await poll(async () => {
    const s = await call('session:get');
    return (
      s.language === 'zh' && s.phase === 'paused' && s.segments.length && s
    );
  }, 'seek and language change collision');
  assert.ok(afterSeekSwitch.languageVersion > pausedSession.languageVersion);
  await call('engine:state', {
    session: {
      ...afterSeekSwitch,
      epoch: afterSeekSwitch.epoch + 100,
      languageVersion: pausedSession.languageVersion,
    },
  });
  assert.equal(
    (await call('session:get')).languageVersion,
    afterSeekSwitch.languageVersion,
  );
  report.checks.push(
    'A simultaneous seek and language switch accepts the new language revision even when a seek epoch is not yet published; older revisions cannot return after selecting the same language again',
  );
  // Fire consecutive choices without waiting for their replies.
  await panel.evaluate(() => {
    const el = document.querySelector('#language');
    for (const value of ['en', 'zh', 'ja', 'en']) {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await poll(async () => {
    const s = await call('session:get');
    return (
      s.language === 'en' &&
      s.phase === 'paused' &&
      s.segments.every((t) => t.text.startsWith('TARGET-en-')) &&
      s
    );
  }, 'latest rapid selection wins');
  assert.equal(await panel.locator('#language').inputValue(), 'en');
  const latest = await call('session:get');
  assert.equal(latest.sourceSubtitles, true);
  assert.equal(latest.targetSubtitles, false);
  await page.locator('video').evaluate((v) => v.parentElement.requestFullscreen());
  await poll(async () => { const v = await playerSnapshot(); return v.sourceVisible && !v.targetVisible; }, 'independent captions in fullscreen');
  await originalSwitch.setChecked(false);
  await targetSwitch.setChecked(true);
  await poll(async () => { const v = await playerSnapshot(); return !v.sourceVisible && v.targetVisible; }, 'change caption choice during fullscreen');
  await page.evaluate(() => document.exitFullscreen());
  report.checks.push('Original-only captions survive cached and rapid target-language changes; fullscreen keeps the choice and accepts an immediate change to target-only');
  await panel.evaluate(
    (s) =>
      chrome.runtime.sendMessage({
        type: 'session:updated',
        session: {
          ...s,
          language: 'ja',
          languageVersion: s.languageVersion - 1,
          epoch: s.epoch + 100,
        },
      }),
    latest,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    await panel.locator('#language').inputValue(),
    'en',
    'Late broadcasts cannot roll back the language selector',
  );

  report.checks.push(
    'Switch while paused keeps the exact paused position; four rapid consecutive choices resolve to the last language without resuming playback',
  );
  // Observe buffering before an uncached decoder/model can finish.
  await panel.locator('#language').selectOption('fr');
  await poll(async () => {
    const s = await call('session:get');
    if (s.language !== 'fr' || s.phase !== 'buffering' || s.segments.length) return false;
    const snapshot = await playerSnapshot();
    const nativePaused = await page.locator('video').evaluate((v) => v.paused);
    return snapshot.src === null && snapshot.paused && !snapshot.caption.includes('TARGET-') && nativePaused;
  }, 'uncached language clears the actual audio/captions and pauses the native video');
  const buffering = await playerSnapshot();
  assert.equal(buffering.src, null);
  assert.equal(buffering.paused, true);
  assert.ok(!buffering.caption.includes('TARGET-'));
  assert.equal(await page.locator('video').evaluate((v) => v.paused), true);
  await panel.locator('#language').selectOption('en');
  await poll(async () => {
    const s = await call('session:get');
    return s.language === 'en' && s.phase === 'paused';
  }, 'cache after uncached cancellation');
  await page.locator('video').evaluate((v) => v.play());
  await poll(
    async () => !(await page.locator('video').evaluate((v) => v.paused)),
    'resume after language switch',
  );
  report.checks.push(
    'An uncached language immediately clears audio/src and old captions and pauses for preparation; switching back cancels that work, restores cache and allows normal resume',
  );
  const second = await context.newPage();
  await second.goto(`chrome-extension://${id}/sidepanel.html`);
  await second.locator('#language:enabled').waitFor();
  await second.waitForFunction(
    () => document.querySelector('#language')?.value === 'en',
  );
  assert.equal(await second.locator('#language').isEnabled(), true);
  assert.equal((await call('settings:get')).autoSaveFiles, false);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    0,
  );
  const stopping = await call('session:get');
  await panel.evaluate(async (s) => {
    const requests = [
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'session:language',
        sessionId: s.id,
        language: 'ja',
      }),
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'session:stop',
      }),
    ];
    await Promise.all(requests);
  }, stopping);
  assert.equal(await call('session:get'), null);
  assert.equal(await page.locator('[data-qvd-overlay]').count(), 0);
  assert.equal(
    (await panel.evaluate(() => chrome.declarativeNetRequest.getSessionRules()))
      .length,
    0,
  );
  report.checks.push(
    'Stop during an in-flight language change wins: session and overlay removed, authentication rules cleaned',
  );
  const original = await page
    .locator('video')
    .evaluate((v) => ({ muted: v.muted, volume: v.volume }));
  assert.equal(original.muted, false);
  assert.ok(Math.abs(original.volume - 0.65) < 0.001);
  report.checks.push(
    'Reopened panels show the active language; default file saving remains off with zero downloads; stop restores the pre-translation original sound settings',
  );
  const nativeUrl = 'https://www.bilibili.com/video/BV1QvdFixture/';
  const audioUrl =
    'https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/1-1-30216.m4s';
  const videoUrl =
    'https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/1_x1-1-100022.m4s';
  await context.route(nativeUrl, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<title>Native source fixture</title><video width="640" height="360"></video><script>window.__playinfo__={data:{dash:{audio:[{baseUrl:${JSON.stringify(audioUrl)},mimeType:'audio/mp4',bandwidth:1}]}}};</script>`,
    }),
  );
  await context.route('https://upos-sz-mirrorhw.bilivideo.com/**', (r) =>
    r.fulfill({ contentType: 'video/mp4', body: bytes }),
  );
  const native = await context.newPage();
  await native.goto(nativeUrl);
  const nativeId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    nativeUrl,
  );
  await panel.evaluate(
    async ({ nativeId, videoUrl }) =>
      chrome.storage.session.set({
        [`source:${nativeId}`]: {
          identity: 'bilibili:/video/BV1QvdFixture/:1',
          source: { url: videoUrl, mime: 'video/mp4' },
        },
      }),
    { nativeId, videoUrl },
  );
  assert.equal(
    (await call('media:discover', { tabId: nativeId }))[0].source.url,
    audioUrl,
    'Ignore legacy persisted video-only sources',
  );
  await native.evaluate(
    async ({ audioUrl, videoUrl }) => {
      await (await fetch(audioUrl)).arrayBuffer();
      await (await fetch(videoUrl)).arrayBuffer();
    },
    { audioUrl, videoUrl },
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    (await call('media:discover', { tabId: nativeId }))[0].source.url,
    audioUrl,
  );
  report.checks.push(
    'Bilibili metadata/audio requests remain selected after a later video-only response; a legacy persisted video-only URL is ignored',
  );
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack;
  throw e;
} finally {
  await fs.writeFile(
    process.env.LANGUAGE_SWITCH_REPORT ?? 'outputs/language-switch-verification.json',
    JSON.stringify(report, null, 2),
  );
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
