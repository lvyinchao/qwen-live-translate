import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const directory = await fs.mkdtemp(path.resolve('work/native-seek-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
});
const report = {
  at: new Date().toISOString(),
  scope: process.env.TRANSLATE
    ? 'Original page mode, anonymous real site, actual Qwen translation with locally configured credentials'
    : 'Original page mode, anonymous real site, no model call',
  discoveries: [],
  responses: [],
};
const url = process.env.VIDEO_URL ?? 'https://v.qq.com/x/cover/mzc00200803dr6b/z4102cn0lk3.html';
const safeUrl = (s) => {
  const u = new URL(s);
  return u.origin + '/…/' + u.pathname.split('/').pop();
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
  const page = await context.newPage();
  page.on('response', (r) => {
    if (/^(audio|video)\//.test(r.headers()['content-type'] ?? ''))
      report.responses.push({
        url: safeUrl(r.url()),
        status: r.status(),
        mime: r.headers()['content-type'],
        length: r.headers()['content-length'],
        range: r.headers()['content-range'],
      });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(Number(process.env.WAIT_MS ?? 35000));
  const tabId = await panel.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    page.url(),
  );
  for (const position of (process.env.POSITIONS ?? '0,1180.15,120,1180.15')
    .split(',')
    .map(Number)) {
    const video = await page.locator('video').evaluateAll((vs, position) => {
      const v = vs.filter((v) => v.duration > 100).sort((a, b) => b.clientWidth - a.clientWidth)[0];
      if (!v) return null;
      v.pause();
      v.currentTime = Math.min(position, v.duration - 35);
      return {
        duration: v.duration,
        currentTime: v.currentTime,
        protected: !!v.mediaKeys,
      };
    }, position);
    await page.waitForTimeout(2000);
    const found = await call('media:discover', { tabId });
    const entry = {
      position,
      video,
      candidates: found.map((c) => ({
        duration: c.duration,
        status: c.sourceStatus,
        reason: c.sourceReason,
        source: c.source
          ? {
              url: safeUrl(c.source.url),
              kind: c.source.kind,
              inline: !!c.source.hlsManifest,
              sabr: !!c.source.sabrRequest,
            }
          : undefined,
      })),
    };
    report.discoveries.push(entry);
    const c = found.find((c) => c.source && c.duration > 100);
    if (c) {
      await call('media:headers', { source: c.source });
      const asset = (await fs.readdir(path.join(extension, 'assets'))).find((f) =>
        /^decode-.*\.js$/.test(f),
      );
      entry.decode = await panel.evaluate(
        async ({ asset, source, start }) => {
          const worker = new Worker(chrome.runtime.getURL('assets/' + asset), {
            type: 'module',
          });
          try {
            return await new Promise((resolve) => {
              const timer = setTimeout(
                () => resolve({ ok: false, error: 'decode timeout' }),
                55000,
              );
              worker.onmessage = (e) => {
                clearTimeout(timer);
                const d = e.data;
                delete d.samples;
                resolve(d);
              };
              worker.onerror = (e) => {
                clearTimeout(timer);
                resolve({ ok: false, error: e.message });
              };
              worker.postMessage({
                id: 'seek',
                type: 'decode',
                source,
                start,
                end: start + 30,
                expectedDuration: source.expectedDuration,
              });
            });
          } finally {
            worker.terminate();
          }
        },
        {
          asset,
          source: { ...c.source, expectedDuration: c.duration },
          start: position,
        },
      );
    }
    console.log(JSON.stringify(entry));
  }
  report.page = safeUrl(page.url());
  if (process.env.TRANSLATE) {
    const cfg = JSON.parse(
      await fs.readFile(path.join(os.homedir(), '.bailian/config.json'), 'utf8'),
    );
    const host = new URL(cfg.base_url).hostname.split('.');
    const language = process.env.TARGET_LANGUAGE ?? 'en';
    await call('settings:save', {
      settings: {
        apiKey: cfg.api_key,
        workspace: host[0],
        region: host[1],
        language,
      },
    });
    const position = Number(process.env.TRANSLATE_START ?? 1180.15);
    await page.locator('video').evaluateAll((vs, position) => {
      const v = vs.filter((v) => v.duration > 100).sort((a, b) => b.clientWidth - a.clientWidth)[0];
      v.pause();
      v.currentTime = position;
    }, position);
    await page.waitForTimeout(1200);
    const candidate = (await call('media:discover', { tabId })).find(
      (c) => c.source && c.duration > 100,
    );
    assert.ok(candidate, 'No native prefetch source');
    const started = Date.now();
    await call('session:start', { candidate, language });
    let state;
    while (Date.now() - started < 120000) {
      state = await call('session:get');
      if (state?.phase === 'error') throw Error(state.error);
      if (state?.phase === 'playing') break;
      await page.waitForTimeout(500);
    }
    assert.equal(state?.phase, 'playing');
    report.translation = {
      language,
      start: position,
      firstReadyMs: Date.now() - started,
      readyThrough: state.readyThrough,
      segments: state.segments.length,
    };
    await page.waitForTimeout(7500);
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    await page.waitForTimeout(2500);
    state = await call('session:get');
    report.translation.playback = {
      phase: state.phase,
      position: state.position,
      segments: state.segments.map((s) => ({
        start: s.start,
        end: s.end,
        sourceText: s.sourceText,
        text: s.text,
      })),
    };
    assert.ok(state.position > position + 5, 'Original page video did not advance');
    assert.ok(
      state.segments.some((s) => s.start >= position && s.text),
      'No real translated utterance at the requested position',
    );
    const diagnostics = await call('session:diagnostics');
    report.translation.audioEvents = diagnostics.value?.events ?? diagnostics.events;
    assert.ok(
      report.translation.audioEvents?.some((e) => e.kind === 'start'),
      'Translated audio did not emit a real playing event',
    );
    await call('session:stop');
    report.translation.stopped = true;
  }
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
} catch (e) {
  report.error = e.message;
  throw e;
} finally {
  await fs.writeFile(
    process.env.REPORT ?? 'outputs/native-seek-verification.json',
    JSON.stringify(report, null, 2),
  );
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
}
