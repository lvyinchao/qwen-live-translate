import { isolatedTestEnv } from './test-environment.mjs';
import { syntheticWav } from '../tests/fixtures/audio.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

await fs.mkdir('work', { recursive: true });
await fs.mkdir('outputs', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('work/cctv-discovery-'));
const extension = path.join(directory, 'extension');
await fs.cp(process.env.EXTENSION_DIR ?? '.output/chrome-mv3', extension, { recursive: true });
const runtime = crypto.createHash('sha256');
const hashTree = async (directory) => {
  for (const name of (await fs.readdir(directory)).sort()) {
    const entry = path.join(directory, name);
    if ((await fs.stat(entry)).isDirectory()) await hashTree(entry);
    else {
      runtime.update(path.relative(extension, entry).split(path.sep).join('/'));
      runtime.update(await fs.readFile(entry));
    }
  }
};
await hashTree(extension);
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
  env: isolatedTestEnv(),
  channel: 'chromium',
  headless: !!process.env.HEADLESS,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
const report = {
  at: new Date().toISOString(),
  runtimeSha256: runtime.digest('hex'),
  version: JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8')).version,
  scope:
    'Built Chrome extension with a controlled CCTV watch-page DOM and fixed-API responses. Generated local WAV metadata only; no CCTV network playback, user account or model calls.',
  checks: [],
  cases: [],
};
const guids = {
  public: '11111111111111111111111111111111',
  protected: '22222222222222222222222222222222',
  wrong: '33333333333333333333333333333333',
  pending: '44444444444444444444444444444444',
  latest: '55555555555555555555555555555555',
  changedPlayer: '66666666666666666666666666666666',
  reload: '77777777777777777777777777777777',
  unrelated: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const watchUrl = 'https://tv.cctv.cn/2026/10/10/VIDEfixture0123456789.shtml';
const audioUrl = (guid) => `https://hls.cntv.cn/asp/hls/audio/${guid}/index.m3u8`;
const rotatedAudioUrl = (guid) => `https://hls-alt.cntv.cn/asp/hls/audio/${guid}/index.m3u8`;
const poll = async (operation, label) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  context.setDefaultTimeout(10000);
  // Only the one controlled page is fulfilled. Other page traffic and every
  // WebSocket are blocked; the worker wrapper below never delegates HTTP fetch.
  await context.route(/^https?:/, (route) => route.abort('blockedbyclient'));
  await context.routeWebSocket(/^wss?:/, (socket) =>
    socket.close({ code: 1000, reason: 'Offline CCTV fixture' }),
  );
  const wav = syntheticWav(8).toString('base64');
  let pageGuid = guids.public;
  for (const filename of ['direct-one.wav', 'direct-two.wav']) {
    await context.route(`https://hls.cntv.cn/${filename}`, (route) =>
      route.fulfill({
        contentType: 'audio/wav',
        body: Buffer.from(wav, 'base64'),
      }),
    );
  }
  await context.route(watchUrl, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Offline CCTV fixture</title><script>window.guid=${JSON.stringify(pageGuid)};</script>
     <div id="_video"><video id="_video_player_html5_api" width="640" height="360" preload="auto" src="data:audio/wav;base64,${wav}"></video></div>
     <aside><video id="unrelated-preview" width="960" height="540" preload="auto" src="data:audio/wav;base64,${wav}"></video></aside>`,
    }),
  );
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: extension });
  const worker = await poll(
    async () =>
      context
        .serviceWorkers()
        .find((value) => value.url() === `chrome-extension://${id}/background.js`),
    'extension worker',
  );
  await worker.evaluate(
    ({ guids }) => {
      const state = {
        calls: [],
        unexpectedFetches: [],
        held: [],
        nowOffset: 0,
        modes: {
          [guids.protected]: 'protected',
          [guids.wrong]: 'wrong-guid',
          [guids.pending]: 'held',
          [guids.changedPlayer]: 'held',
          [guids.reload]: 'held',
        },
      };
      globalThis.__cctvFixture = state;
      const originalNow = Date.now;
      Date.now = () => originalNow() + state.nowOffset;
      const body = (guid) => {
        const mode = state.modes[guid];
        const returnedGuid = mode === 'wrong-guid' ? guids.unrelated : guid;
        const cdn = mode === 'rotated' ? 'hls-alt.cntv.cn' : 'hls.cntv.cn';
        return {
          ack: 'yes',
          status: '001',
          public: 1,
          play: 1,
          is_protected: mode === 'protected' ? 1 : 0,
          is_preview: 0,
          is_invalid_copyright: 0,
          title: 'Offline public CCTV fixture',
          video: { totalLength: 8 },
          hls_url: `https://${cdn}/asp/hls/video/${returnedGuid}/master.m3u8`,
          manifest: { hls_audio_url: `https://${cdn}/asp/hls/audio/${returnedGuid}/index.m3u8` },
        };
      };
      globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (
          url.origin !== 'https://vdn.apps.cntv.cn' ||
          url.pathname !== '/api/getHttpVideoInfo.do'
        ) {
          state.unexpectedFetches.push(url.origin + url.pathname);
          throw new Error('Offline fixture blocked an unexpected worker fetch');
        }
        const guid = url.searchParams.get('pid');
        state.calls.push({
          guid,
          method: options?.method ?? 'GET',
          parameters: [...url.searchParams.keys()],
        });
        if (state.modes[guid] === 'held')
          await new Promise((resolve) => state.held.push({ guid, resolve }));
        return new Response(JSON.stringify(body(guid)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
    },
    { guids },
  );

  // Load the watch page before the sidepanel exists, with no observed playlist.
  const page = await context.newPage();
  await page.goto(watchUrl);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('video')].every(
      (video) => video.readyState >= 1 && video.duration === 8,
    ),
  );
  assert.equal((await worker.evaluate(() => globalThis.__cctvFixture.calls)).length, 0);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    watchUrl,
  );
  const call = (type, extra = {}) =>
    panel.evaluate(
      async ({ type, extra }) => {
        const result = await chrome.runtime.sendMessage({ target: 'background', type, ...extra });
        if (!result?.ok) throw new Error(result?.error ?? 'Background did not respond');
        return result.value;
      },
      { type, extra },
    );
  const scan = () => call('media:discover', { tabId });
  const main = async (candidates) => {
    const playerId = await page
      .locator('#_video_player_html5_api')
      .evaluate((video) => video.dataset.qvdId);
    const candidate = candidates.find((value) => value.id === playerId && value.frameId === 0);
    assert.ok(candidate, 'the native CCTV main player must remain discoverable');
    return candidate;
  };
  const count = (guid) =>
    worker.evaluate(
      (guid) => globalThis.__cctvFixture.calls.filter((value) => value.guid === guid).length,
      guid,
    );
  const setGuid = (guid) =>
    page.evaluate((guid) => {
      window.guid = guid;
    }, guid);
  const noApiSource = (candidates) =>
    assert.equal(
      candidates.some((candidate) => candidate.source?.kind === 'hls'),
      false,
    );
  const waitHeld = (guid) =>
    poll(
      async () =>
        worker.evaluate(
          (guid) => globalThis.__cctvFixture.held.some((item) => item.guid === guid),
          guid,
        ),
      'held CCTV API request',
    );
  const releaseHeld = (guid) =>
    worker.evaluate((guid) => {
      const state = globalThis.__cctvFixture;
      const waiting = state.held.filter((item) => item.guid === guid);
      state.held = state.held.filter((item) => item.guid !== guid);
      for (const item of waiting) item.resolve();
    }, guid);
  const setMainSource = async (url, duration = 8) => {
    await page.locator('#_video_player_html5_api').evaluate((video, url) => {
      video.src = url;
    }, url);
    await page.waitForFunction(
      ({ url, duration }) => {
        const video = document.querySelector('#_video_player_html5_api');
        return video.currentSrc === url && video.readyState >= 1 && video.duration === duration;
      },
      { url, duration },
    );
  };

  const first = await scan();
  const initial = await main(first);
  assert.equal(initial.sourceStatus, 'ready');
  assert.equal(initial.source?.kind, 'hls');
  assert.equal(
    initial.source?.url,
    audioUrl(guids.public),
    'prefer the API audio HLS over its video playlist',
  );
  assert.equal(
    first.filter((candidate) => candidate.source?.url === audioUrl(guids.public)).length,
    1,
  );
  const sideId = await page.locator('#unrelated-preview').evaluate((video) => video.dataset.qvdId);
  assert.ok(first.some((candidate) => candidate.id === sideId));
  assert.equal(first.find((candidate) => candidate.id === sideId)?.source, undefined);
  report.checks.push(
    'A page loaded before the sidepanel, without observed playlist traffic, obtains the fixed-API audio HLS for its unique native main player only; a larger side video cannot take that source',
  );
  report.cases.push({
    name: 'public-main',
    players: first.length,
    sourceKind: initial.source.kind,
    url: initial.source.url,
  });

  await scan();
  await scan();
  assert.equal(await count(guids.public), 1);
  report.checks.push(
    'Repeated scans reuse the successful current-GUID API lookup instead of issuing duplicate requests',
  );

  await worker.evaluate((guid) => {
    globalThis.__cctvFixture.modes[guid] = 'rotated';
    globalThis.__cctvFixture.nowOffset = 5 * 60000 + 1000;
  }, guids.public);
  let rotatedCandidates;
  try {
    rotatedCandidates = await scan();
  } finally {
    await worker.evaluate(() => {
      globalThis.__cctvFixture.nowOffset = 0;
    });
  }
  const rotated = await main(rotatedCandidates);
  assert.equal(await count(guids.public), 2, 'a lookup is refreshed after its five-minute TTL');
  assert.equal(rotated.source?.url, rotatedAudioUrl(guids.public));
  assert.notEqual(rotated.source.url, initial.source.url);
  assert.equal(
    rotated.mediaId,
    initial.mediaId,
    'CDN rotation must not change programme/cache identity',
  );
  assert.equal(rotatedCandidates.find((candidate) => candidate.id === sideId)?.source, undefined);
  report.cases.push({
    name: 'expired-cache-cdn-rotation',
    previousUrl: initial.source.url,
    url: rotated.source.url,
    previousMediaId: initial.mediaId,
    mediaId: rotated.mediaId,
    requests: await count(guids.public),
  });
  report.checks.push(
    'After the five-minute lookup cache expires, a rotated public CDN URL is refreshed while the same programme keeps its media/cache identity; the side player remains unassociated',
  );

  const direct = [];
  for (const filename of ['direct-one.wav', 'direct-two.wav']) {
    const url = `https://hls.cntv.cn/${filename}`;
    await setMainSource(url);
    const candidate = await main(await scan());
    assert.equal(candidate.source?.url, url);
    assert.equal(candidate.source?.kind, 'file');
    assert.notEqual(
      candidate.mediaId,
      rotated.mediaId,
      'a direct file must not borrow the fixed-API programme identity',
    );
    direct.push({ url, mediaId: candidate.mediaId });
  }
  assert.notEqual(
    direct[0].mediaId,
    direct[1].mediaId,
    'different direct media must keep distinct identities despite the same page GUID and duration',
  );
  await setMainSource(`data:audio/wav;base64,${wav}`);
  assert.equal((await main(await scan())).source?.url, rotatedAudioUrl(guids.public));
  report.cases.push({ name: 'direct-file-identity', files: direct });
  report.checks.push(
    'A main player using either of two distinct direct files retains the actual direct URL and distinct media identities, rather than borrowing the page GUID identity; restoring the native source recovers the API HLS',
  );

  const shortWav = syntheticWav(3).toString('base64');
  await page.locator('#_video_player_html5_api').evaluate((video, wav) => {
    video.src = `data:audio/wav;base64,${wav}`;
  }, shortWav);
  await page.waitForFunction(
    () => document.querySelector('#_video_player_html5_api').duration === 3,
  );
  noApiSource(await scan());
  assert.equal(await count(guids.public), 2);
  await page.locator('#_video_player_html5_api').evaluate((video, wav) => {
    video.src = `data:audio/wav;base64,${wav}`;
  }, wav);
  await page.waitForFunction(
    () => document.querySelector('#_video_player_html5_api').duration === 8,
  );
  assert.equal((await main(await scan())).source?.url, rotatedAudioUrl(guids.public));
  report.checks.push(
    'A cached API result is withheld when main-player duration differs by more than two seconds and becomes usable again only after the matching player returns',
  );

  await page.evaluate(() => {
    const duplicate = document.querySelector('#_video_player_html5_api').cloneNode(true);
    duplicate.removeAttribute('data-qvd-id');
    duplicate.dataset.fixtureDuplicate = 'true';
    document.querySelector('#_video').append(duplicate);
  });
  await page.waitForFunction(
    () => document.querySelector('[data-fixture-duplicate]').duration === 8,
  );
  noApiSource(await scan());
  await page.locator('[data-fixture-duplicate]').evaluate((video) => video.remove());
  assert.equal((await main(await scan())).source?.url, rotatedAudioUrl(guids.public));
  report.checks.push(
    'Two native-main markers are treated as ambiguous instead of assigning one playlist to either player',
  );

  await setGuid(guids.protected);
  noApiSource(await scan());
  assert.equal(await count(guids.protected), 1);
  report.checks.push(
    'Protected API metadata produces no playable HLS and does not reuse the preceding public GUID cache',
  );
  await setGuid(guids.wrong);
  noApiSource(await scan());
  assert.equal(await count(guids.wrong), 1);
  report.checks.push(
    'A response whose HLS belongs to a different GUID is rejected instead of being associated with the current player',
  );
  await setGuid('invalid-guid');
  const beforeInvalid = await worker.evaluate(() => globalThis.__cctvFixture.calls.length);
  noApiSource(await scan());
  assert.equal(await worker.evaluate(() => globalThis.__cctvFixture.calls.length), beforeInvalid);
  report.checks.push(
    'An invalid page GUID triggers no API request and cannot resurrect an old cached playlist',
  );

  await setGuid(guids.changedPlayer);
  const changedPlayerScan = scan();
  await waitHeld(guids.changedPlayer);
  await setMainSource(`data:audio/wav;base64,${shortWav}`, 3);
  await releaseHeld(guids.changedPlayer);
  const changedPlayerResult = await changedPlayerScan;
  noApiSource(changedPlayerResult);
  assert.equal(
    (await main(changedPlayerResult)).duration,
    3,
    'the API result must be bound against the current player DOM, not the initial scan',
  );
  await setMainSource(`data:audio/wav;base64,${wav}`);
  assert.equal((await main(await scan())).source?.url, audioUrl(guids.changedPlayer));
  assert.equal(await count(guids.changedPlayer), 1);
  report.checks.push(
    'When the same GUID lookup is pending, replacing its eight-second media with three-second media prevents the delayed HLS from being assigned; a later matching player can recover from the cached API result',
  );

  pageGuid = guids.reload;
  await setGuid(pageGuid);
  const beforeReload = scan();
  await waitHeld(guids.reload);
  const oldPlayerId = await page
    .locator('#_video_player_html5_api')
    .evaluate((video) => video.dataset.qvdId);
  await page.reload();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('video')].every(
      (video) => video.readyState >= 1 && video.duration === 8,
    ),
  );
  assert.equal(await page.evaluate(() => window.guid), guids.reload);
  const afterReload = scan();
  await poll(
    () =>
      page
        .locator('#_video_player_html5_api')
        .evaluate(
          (video, oldPlayerId) =>
            Boolean(video.dataset.qvdId && video.dataset.qvdId !== oldPlayerId),
          oldPlayerId,
        ),
    'new document player scanned after same-URL reload',
  );
  await poll(
    async () => (await count(guids.reload)) === 2,
    'new document starts a fresh fixed-API lookup',
  );
  await releaseHeld(guids.reload);
  const oldDocumentResult = await beforeReload;
  const newDocumentResult = await afterReload;
  report.cases.push({
    name: 'same-url-guid-reload',
    guid: guids.reload,
    oldPlayerId,
    newPlayerId: await page
      .locator('#_video_player_html5_api')
      .evaluate((video) => video.dataset.qvdId),
    oldScan: oldDocumentResult.map(({ id, duration, sourceStatus, source }) => ({
      id,
      duration,
      sourceStatus,
      sourceUrl: source?.url,
    })),
    newScanPlayers: newDocumentResult.length,
  });
  assert.equal(
    oldDocumentResult.length,
    0,
    'a scan owned by the previous document must not return a result after a same-URL, same-GUID reload',
  );
  assert.equal((await main(newDocumentResult)).source?.url, audioUrl(guids.reload));
  report.checks.push(
    'Reloading the same URL and GUID creates a new observation/document owner: a held scan from the previous page is discarded while the new page scan succeeds',
  );

  await setGuid(guids.pending);
  const oldScan = scan();
  await waitHeld(guids.pending);
  await setGuid(guids.latest);
  const latestScan = await scan();
  assert.equal((await main(latestScan)).source?.url, audioUrl(guids.latest));
  await releaseHeld(guids.pending);
  assert.equal(
    (await oldScan).length,
    0,
    'the delayed old GUID result must be discarded after the page changes',
  );
  assert.equal((await main(await scan())).source?.url, audioUrl(guids.latest));
  assert.equal(await count(guids.latest), 1);
  report.checks.push(
    'Changing the GUID within the same page invalidates previous association; a delayed old lookup cannot replace the latest result or its cache',
  );
  const traffic = await worker.evaluate(() => ({
    calls: globalThis.__cctvFixture.calls,
    unexpectedFetches: globalThis.__cctvFixture.unexpectedFetches,
  }));
  assert.deepEqual(traffic.unexpectedFetches, []);
  assert.ok(
    traffic.calls.every(
      (value) =>
        value.method === 'GET' && value.parameters.length === 1 && value.parameters[0] === 'pid',
    ),
  );
  report.requests = traffic.calls;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
  await fs.writeFile(
    process.env.CCTV_DISCOVERY_REPORT ?? 'outputs/cctv-discovery-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
}
