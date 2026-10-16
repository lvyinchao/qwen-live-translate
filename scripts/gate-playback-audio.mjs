import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isolatedTestEnv } from './test-environment.mjs';
const wav = (seconds, tone = false) => {
  const rate = 24000, count = Math.round(rate * seconds), data = Buffer.alloc(44 + count * 2);
  data.write('RIFF'); data.writeUInt32LE(36 + count * 2, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  if (tone) for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 1000), 44 + i * 2);
  return data.toString('base64');
};
await fs.mkdir('work', { recursive: true });
await fs.mkdir('outputs', { recursive: true });
const extension = await fs.mkdtemp(path.resolve('work/playback-audio-extension-'));
const profile = await fs.mkdtemp(path.resolve('work/playback-audio-browser-'));
await fs.cp(path.resolve(process.env.EXTENSION_DIR ?? '.output/chrome-mv3'), extension, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  env: isolatedTestEnv(), channel: 'chromium', headless: !!process.env.HEADLESS,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
});
const result = { at: new Date().toISOString(), scope: 'Synthetic WAV video and translated audio in an isolated Chromium profile. Software playback observations only; no model or live-video acceptance.', checks: [], onsetSourceSeconds: null, errors: [] };
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: extension });
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.evaluate(() => {
    window.__fixturePlayerTelemetry = [];
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'player:metric' || message.type === 'player:skip')
        window.__fixturePlayerTelemetry.push(structuredClone(message));
    });
  });
  await context.route('https://www.bilibili.com/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<video data-qvd-id="audio-fixture" width="640" height="360" src="data:audio/wav;base64,${wav(8)}"></video>` }));
  const page = await context.newPage();
  page.on('pageerror', (error) => result.errors.push(error.message));
  await page.goto('https://www.bilibili.com/video/BV13rsaeaEgE/');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
  await page.locator('video').evaluate((video) => { video.playbackRate = 1.5; });
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.bilibili.com/*' }))[0].id);
  const send = (message) => panel.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), { tabId, message });
  const cdp = await context.newCDPSession(page);
  const audios = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const nodes = [];
    const walk = (node) => {
      if (node.nodeName === 'AUDIO') nodes.push(node.backendNodeId);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
      if (node.contentDocument) walk(node.contentDocument);
    }; walk(root);
    const rows = [];
    for (const backendNodeId of nodes) {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
      const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId,
        functionDeclaration: `function(){
          if (!this.dataset.audited) {
            this.dataset.audited="true";
            this.dataset.fixtureAudioId=crypto.randomUUID();
            this.addEventListener("playing", () => {
              (window.__fixtureOnsets ??= []).push({mediaTime:document.querySelector("video").currentTime,audioTime:this.currentTime,duration:this.duration});
            });
            for (const type of ["playing", "pause", "ended"]) this.addEventListener(type, (event) => {
              const record = {
                id:this.dataset.fixtureAudioId,type,at:performance.now(),trusted:event.isTrusted,
                mediaTime:document.querySelector("video").currentTime,
                audioTime:this.currentTime,duration:this.duration,
              };
              // The natural-tail case delays observation of a real native event.
              // Its property and the observer's record are distinct conditions.
              if (type === "ended" && window.__fixtureHoldEndedRecords)
                (window.__fixturePendingAudioEnds ??= []).push(record);
              else (window.__fixtureAudioEvents ??= []).push(record);
            });
          }
          return {id:this.dataset.fixtureAudioId,paused:this.paused,ended:this.ended,time:this.currentTime,volume:this.volume,src:this.getAttribute("src"),ready:this.readyState,duration:Number.isFinite(this.duration)?this.duration:null};
        }`, returnByValue: true });
      await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); rows.push({ ...result.value, backendNodeId });
    }
    return rows;
  };
  const wait = async (condition, label) => {
    const deadline = Date.now() + 8000;
    while (!await condition()) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const session = { id: 'audio-fixture', epoch: 0, languageVersion: 0, language: 'zh', phase: 'paused',
    candidate: { id: 'audio-fixture', mediaId: 'bilibili:/video/BV13rsaeaEgE/:1', frameId: 0, tabId, site: 'bilibili', duration: 8 },
    position: 0, rate: 1.5, readyThrough: 8, inputThrough: 8, skipped: 0,
    originalVolume: 0, dubVolume: 1, subtitles: true, segments: [] };
  const segment = (id, start, end) => ({ id, start, end, mediaId: session.candidate.mediaId,
    language: 'zh', voice: 'original-auto-v1', sourceText: 'Synthetic fixture', text: '合成音频测试',
    audio: wav(end - start, true), audioDuration: end - start });
  const telemetry = (sessionId, segmentId) => panel.evaluate(({ sessionId, segmentId }) =>
    window.__fixturePlayerTelemetry.filter((event) => event.sessionId === sessionId && event.segmentId === segmentId),
  { sessionId, segmentId });
  const resetCase = async (name) => {
    await page.locator('video').evaluate(async (video) => {
      video.pause(); video.playbackRate = 1; video.currentTime = 0;
      video.muted = false; video.volume = 0.65;
      window.__fixtureAudioEvents = []; window.__fixtureOnsets = [];
    });
    await wait(async () => await page.locator('video').evaluate((video) => !video.seeking && video.currentTime < 0.01), 'reset native fixture clock');
    const next = { ...session, id: name, rate: 1, position: 0, phase: 'paused' };
    assert.equal((await send({ type: 'player:attach', session: next })).ok, true);
    return next;
  };
  const addAudio = async (next, id, start, end, audioDuration, waitForMetadata = true) => {
    const clip = { ...segment(id, start, end), audio: wav(audioDuration, true), audioDuration };
    assert.equal((await send({ type: 'player:segment', epoch: next.epoch, languageVersion: 0, segment: clip })).ok, true);
    if (waitForMetadata) await wait(async () => (await audios()).some((audio) => audio.duration === audioDuration && audio.ready >= 1 && audio.src), `${id} metadata`);
    return clip;
  };
  const controlTailAt = async (audio, boundary) => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: audio.backendNodeId });
    try {
      const reply = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, awaitPromise: true, returnByValue: true,
        arguments: [{ value: boundary }],
        functionDeclaration: `async function(boundary) {
          const audio = this, video = document.querySelector("video"), deadline = performance.now() + 6000;
          return await new Promise((resolve, reject) => {
            const timer = setInterval(() => {
              if (performance.now() > deadline) { clearInterval(timer); reject(new Error("Tail injection did not reach its source boundary")); return; }
              if (video.currentTime < boundary - 0.1) return;
              if (!audio.getAttribute("src") || audio.ended) {
                clearInterval(timer); resolve({missed:true,videoTime:video.currentTime,audioTime:audio.currentTime,ended:audio.ended}); return;
              }
              // Keep a real decoded audio tail at 60 ms until the chosen source
              // boundary. No fake clock, synthetic audio-ended event or model is used.
              audio.currentTime = audio.duration - 0.06;
              // Keep injected tails from naturally draining during a delayed
              // fixture callback. The source-playing tick restores the real plan.
              audio.playbackRate = 0.125;
              if (video.currentTime < boundary) return;
              clearInterval(timer);
              const observed={missed:false,videoTime:video.currentTime,audioTime:audio.currentTime,
                remaining:audio.duration-audio.currentTime,ended:audio.ended};
              // Exercise the normal source-playing tick at that precise boundary.
              video.dispatchEvent(new Event("playing"));
              resolve(observed);
            }, 2);
          });
        }`,
      });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
  };
  assert.equal((await send({ type: 'player:attach', session })).ok, true);
  await send({ type: 'player:segment', epoch: 0, languageVersion: 0, segment: segment('first', 1, 2.5) });
  await send({ type: 'player:segment', epoch: 0, languageVersion: 0, segment: segment('next', 4, 6) });
  await wait(async () => (await audios()).some((audio) => audio.ready >= 1 && audio.src), 'first preload metadata');
  assert.equal((await audios()).every((audio) => audio.paused), true);
  await send({ type: 'player:mix', sessionId: session.id, languageVersion: 0, originalVolume: 0, dubVolume: 0, subtitles: true });
  assert.equal((await audios()).every((audio) => audio.volume === 0), true);
  await send({ type: 'player:mix', sessionId: session.id, languageVersion: 0, originalVolume: 0, dubVolume: 1, subtitles: true });
  assert.equal((await audios()).every((audio) => audio.volume === 1), true);
  result.checks.push('Volume changes apply to active and preloaded audio before the next utterance is activated');
  await page.locator('video').evaluate((video) => video.play());
  await wait(async () => await page.evaluate(() => window.__fixtureOnsets?.length > 0), 'first translated utterance starts');
  const onset = await page.evaluate(() => window.__fixtureOnsets[0]);
  result.onsetSourceSeconds = onset.mediaTime;
  assert.ok(result.onsetSourceSeconds >= 1, 'preloading must not start audio early');
  assert.ok(result.onsetSourceSeconds - 1 < 0.3, 'synthetic 1.5× onset must stay below 300 ms in source time');
  await wait(async () => (await audios()).some((audio) => audio.duration === 2 && audio.ready >= 1 && audio.paused), 'next utterance preloads while the first plays');
  result.checks.push('Next complete utterance preloads while remaining silent; 1.5× activation follows the source start within 300 ms in this synthetic observation');
  await page.locator('video').evaluate((video) => video.pause());
  await wait(async () => (await audios()).every((audio) => audio.paused), 'pause propagates to translated audio');
  await page.locator('video').evaluate((video) => { video.currentTime = 4.2; });
  await wait(async () => { const rows = await audios(); return rows.length === 1 && rows.every((audio) => !audio.src && audio.paused); }, 'seek releases active and preloaded WAVs');
  result.checks.push('Pausing stops audio and seeking releases the active and future decoded sources');
  await send({ type: 'player:state', session: { ...session, epoch: 1, position: 4.2 } });
  await send({ type: 'player:segment', epoch: 1, languageVersion: 0, segment: segment('next', 4, 6) });
  await wait(async () => (await audios()).some((audio) => audio.ready >= 1 && audio.src), 'cache seek source reload');
  const urls = (await audios()).map((audio) => audio.src).filter(Boolean);
  await send({ type: 'player:stop', sessionId: session.id });
  assert.equal((await audios()).length, 0);
  const revoked = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
    try { await fetch(url); return false; } catch { return true; }
  })), urls);
  assert.equal(revoked.every(Boolean), true);
  assert.equal(await page.locator('video').evaluate((video) => video.muted), false);
  result.checks.push('Stop removes every audio element, revokes cached Blob URLs and restores native volume');

  const natural = await resetCase('short-natural-tail');
  const naturalClip = await addAudio(natural, 'short-natural', 0.5, 4, 1);
  await page.evaluate(() => {
    window.__fixtureHoldEndedRecords = true;
    window.__fixturePendingAudioEnds = [];
  });
  await page.locator('video').evaluate((video) => video.play());
  await wait(async () => (await audios()).some((audio) => !audio.paused && audio.time > 0.05 && audio.duration === 1), 'short utterance is genuinely playing');
  await wait(async () => (await telemetry(natural.id, naturalClip.id)).some((event) => event.kind === 'start'), 'short utterance receives a real playing event');
  const naturalAudio = (await audios()).find((audio) => audio.duration === 1 && audio.src);
  const naturalInjection = await controlTailAt(naturalAudio, naturalClip.start + naturalClip.audioDuration);
  assert.equal(naturalInjection.missed, false, 'the fixture must observe a positive real audio tail after predicted completion');
  assert.ok(naturalInjection.remaining > 0 && naturalInjection.remaining < 0.1);
  await wait(async () => (await audios()).some((audio) => audio.id === naturalAudio.id && audio.ended), 'real audio ended before the source sentence ends');
  await wait(async () => page.evaluate((audioId) => window.__fixturePendingAudioEnds.some((event) =>
    event.id === audioId && event.type === 'ended' && event.trusted), naturalAudio.id), 'native ended event reaches its delayed observer');
  assert.equal(await page.evaluate((audioId) => window.__fixtureAudioEvents.some((event) =>
    event.id === audioId && event.type === 'ended'), naturalAudio.id), false,
  'ended=true must not be mistaken for an observer record already being available');
  await page.evaluate(() => {
    window.__fixtureHoldEndedRecords = false;
    window.__fixtureAudioEvents.push(...window.__fixturePendingAudioEnds);
    window.__fixturePendingAudioEnds = [];
  });
  await wait(async () => page.evaluate((audioId) => window.__fixtureAudioEvents.some((event) =>
    event.id === audioId && event.type === 'ended'), naturalAudio.id), 'real native ended event is recorded');
  const naturalEnd = await page.evaluate((audioId) => window.__fixtureAudioEvents.find((event) => event.id === audioId && event.type === 'ended'), naturalAudio.id);
  assert.equal(naturalEnd.trusted, true, 'natural completion must come from a real media ended event');
  assert.ok(naturalEnd.mediaTime < naturalClip.end - 0.5, 'short translation must finish inside the original sentence window');
  await wait(async () => await page.locator('video').evaluate((video) => video.currentTime) > naturalEnd.mediaTime + 0.35, 'post-completion timeline blank');
  const replayed = await page.evaluate(({ audioId, at }) => window.__fixtureAudioEvents.some((event) => event.id === audioId && event.type === 'playing' && event.at > at), { audioId: naturalAudio.id, at: naturalEnd.at });
  assert.equal(replayed, false, 'ticks must not replay an already completed short utterance');
  const naturalStop = await send({ type: 'player:stop', sessionId: natural.id });
  const naturalTerminals = naturalStop.terminals.filter((event) => event.segmentId === naturalClip.id);
  assert.equal(naturalTerminals.length, 1);
  assert.equal(naturalTerminals[0].reason, 'natural');
  assert.equal(naturalTerminals[0].remaining, 0);
  assert.equal((await telemetry(natural.id, naturalClip.id)).some((event) => event.type === 'player:skip'), false);
  result.shortNaturalTail = { injection: naturalInjection, realEndedAtSourceTime: naturalEnd.mediaTime,
    delayedNativeEventRecord: true, replayed, terminal: naturalTerminals[0] };
  result.checks.push('A real short WAV with a controlled 60 ms tail finishes naturally after predicted completion, before source end, emits exactly one natural terminal, and does not replay during the timeline blank');

  const cut = await resetCase('sub-100ms-timeline-cut');
  const cutClip = await addAudio(cut, 'short-expired-tail', 0.5, 1.5, 6);
  await page.locator('video').evaluate((video) => video.play());
  await wait(async () => (await audios()).some((audio) => !audio.paused && audio.time > 0.05 && audio.duration === 6), 'long utterance is genuinely playing');
  await wait(async () => (await telemetry(cut.id, cutClip.id)).some((event) => event.kind === 'start'), 'long utterance receives a real playing event');
  const cutAudio = (await audios()).find((audio) => audio.duration === 6 && audio.src);
  const cutInjection = await controlTailAt(cutAudio, cutClip.end);
  await wait(async () => (await audios()).every((audio) => !audio.src), 'source deadline clears the expired utterance');
  await wait(async () => (await telemetry(cut.id, cutClip.id)).some((event) => event.type === 'player:skip'), 'a positive sub-100ms cut emits player:skip');
  const cutStop = await send({ type: 'player:stop', sessionId: cut.id });
  const cutTerminals = cutStop.terminals.filter((event) => event.segmentId === cutClip.id);
  assert.equal(cutTerminals.length, 1);
  assert.equal(cutTerminals[0].reason, 'timeline-cut');
  assert.ok(cutTerminals[0].remaining > 0 && cutTerminals[0].remaining < 0.1, 'every positive tail, including less than 100 ms, must be reported');
  const skips = (await telemetry(cut.id, cutClip.id)).filter((event) => event.type === 'player:skip');
  assert.equal(skips.length, 1);
  assert.equal(skips[0].reason, 'timeline-cut');
  assert.ok(Math.abs(skips[0].remaining - cutTerminals[0].remaining) < 0.001);
  result.shortTimelineCut = { injection: cutInjection, terminal: cutTerminals[0], skipRemaining: skips[0].remaining };
  result.checks.push('At the source sentence deadline, a real positive tail shorter than 100 ms is truncated and produces exactly one timeline-cut terminal and skip with matching remaining duration');

  const stopping = await resetCase('stop-terminal-and-cleanup');
  const stoppedClip = await addAudio(stopping, 'stop-active', 0.5, 4, 2.5);
  // Only the nearest upcoming utterance is preloaded. Queue the next one now;
  // its metadata becomes available after stop-active moves into active playback.
  await addAudio(stopping, 'stop-future', 5, 7, 1.5, false);
  await page.locator('video').evaluate((video) => video.play());
  await wait(async () => (await audios()).some((audio) => !audio.paused && audio.duration === 2.5 && audio.time > 0.1), 'stop fixture active utterance starts');
  await wait(async () => (await telemetry(stopping.id, stoppedClip.id)).some((event) => event.kind === 'start'), 'stopped utterance receives a real playing event');
  await wait(async () => (await audios()).some((audio) => audio.duration === 1.5 && audio.ready >= 1 && audio.src), 'stop-future becomes the next preload');
  const stoppingUrls = (await audios()).map((audio) => audio.src).filter(Boolean);
  assert.equal(stoppingUrls.length, 2, 'stop fixture must include active and preloaded audio');
  const readable = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => { try { return (await fetch(url)).ok; } catch { return false; } })), stoppingUrls);
  assert.equal(readable.every(Boolean), true, 'both Blob URLs must be readable before stop');
  const stopped = await send({ type: 'player:stop', sessionId: stopping.id });
  const stoppedTerminals = stopped.terminals.filter((event) => event.segmentId === stoppedClip.id);
  assert.equal(stoppedTerminals.length, 1);
  assert.equal(stoppedTerminals[0].type, 'player:metric');
  assert.equal(stoppedTerminals[0].sessionId, stopping.id);
  assert.equal(stoppedTerminals[0].epoch, stopping.epoch);
  assert.equal(stoppedTerminals[0].languageVersion, 0);
  assert.equal(stoppedTerminals[0].reason, 'stop');
  assert.ok(stoppedTerminals[0].remaining > 0);
  assert.equal(stopped.terminals.some((event) => event.segmentId === 'stop-future'), false, 'an unheard preload must not be counted as a played terminal');
  assert.equal((await audios()).length, 0);
  const stoppedRevoked = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => { try { await fetch(url); return false; } catch { return true; } })), stoppingUrls);
  assert.equal(stoppedRevoked.every(Boolean), true);
  assert.equal(await page.locator('video').evaluate((video) => video.muted), false);
  assert.ok(Math.abs(await page.locator('video').evaluate((video) => video.volume) - 0.65) < 0.001);
  result.explicitStop = { terminal: stoppedTerminals[0], audioNodesRemaining: 0, readableBeforeStop: readable.every(Boolean), revokedAfterStop: stoppedRevoked.every(Boolean) };
  result.checks.push('Stop returns the active utterance terminal in its acknowledged response, omits unheard preloads, removes both audio DOM nodes, revokes previously readable Blob URLs, and restores original mute/volume');
  assert.deepEqual(result.errors, []);
} finally {
  await context.close();
  await fs.rm(extension, { recursive: true, force: true });
  await fs.rm(profile, { recursive: true, force: true });
  await fs.writeFile(process.env.PLAYBACK_AUDIO_REPORT ?? 'outputs/playback-audio-verification.json', JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result));
