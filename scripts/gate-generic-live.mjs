import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = await fs.mkdtemp(path.resolve('work/generic-live-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const context = await chromium.launchPersistentContext(
  path.join(directory, 'profile'),
  {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  },
);
const report = {
  at: new Date().toISOString(),
  scope:
    'Anonymous public-site discovery, no login and no model calls; failure to load/resolve is recorded, not counted as accepted',
  sites: [],
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
  const requested = process.env.VIDEO_URLS?.split(',').map((url) => [url, 'a']);
  const sites = requested ?? [
    ['https://www.youku.com/', 'a[href*="v_show/id_"]'],
    ['https://trailer.iqiyi.com/index.html', 'a[href*="iqiyi.com/v_"]'],
    ['https://v.qq.com/', 'a[href*="/x/cover/"]'],
  ];
  for (const [landing, selector] of sites) {
    const page = await context.newPage();
    const r = { landing };
    report.sites.push(r);
    try {
      const response = await page.goto(landing, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      r.httpStatus = response?.status();
      await page.waitForTimeout(4000);
      if (!requested) {
        const href = await page
          .locator(selector)
          .first()
          .getAttribute('href', { timeout: 8000 });
        if (!href) throw Error('No public video link found');
        const target = new URL(href, page.url()).href;
        await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        });
      }
      await page.waitForTimeout(7000);
      r.page = new URL(page.url()).origin + new URL(page.url()).pathname;
      r.title = await page.title();
      const tabId = await panel.evaluate(
        async (url) =>
          (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
        page.url(),
      );
      const found = await call('media:discover', { tabId });
      r.candidates = found.map((c) => ({
        site: c.site,
        frameId: c.frameId,
        duration: c.duration,
        sourceStatus: c.sourceStatus,
        sourceKind: c.source?.kind,
        mime: c.source?.mime,
        reason: c.sourceReason,
        detectedMedia: c.detectedMedia,
      }));
      r.detected = found.length > 0;
      r.prefetchable = found.some((c) => !!c.source);
      if (
        process.env.DECODE_AHEAD &&
        found.some((c) => !!c.source && c.duration > 10)
      ) {
        const c = found.find((c) => !!c.source && c.duration > 10);
        await page
          .locator('video')
          .evaluateAll((vs) => vs.forEach((v) => v.pause()));
        await call('media:headers', { source: c.source });
        const asset = (await fs.readdir(path.join(extension, 'assets'))).find(
          (f) => /^decode-.*\.js$/.test(f),
        );
        const start = Math.min(Math.max(3, c.currentTime + 10), c.duration - 3),
          end = start + 2;
        r.prefetch = await panel.evaluate(
          async ({ asset, source, start, end }) => {
            const worker = new Worker(
              chrome.runtime.getURL('assets/' + asset),
              { type: 'module' },
            );
            try {
              return await new Promise((resolve) => {
                const timer = setTimeout(
                  () => resolve({ ok: false, error: 'decode timeout' }),
                  50000,
                );
                worker.onmessage = (e) => {
                  if (e.data.id !== 'live') return;
                  clearTimeout(timer);
                  if (!e.data.ok) {
                    resolve({ ok: false, error: e.data.error });
                    return;
                  }
                  const samples = new Float32Array(e.data.samples);
                  let power = 0;
                  for (const s of samples) power += s * s;
                  resolve({
                    ok: true,
                    start,
                    end,
                    decodedStart: e.data.decodedStart,
                    decodedEnd: e.data.decodedEnd,
                    samples: samples.length,
                    rms: Math.sqrt(power / samples.length),
                  });
                };
                worker.onerror = () => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: 'worker error' });
                };
                worker.postMessage({
                  id: 'live',
                  type: 'decode',
                  source,
                  start,
                  end,
                });
              });
            } finally {
              worker.terminate();
            }
          },
          { asset, source: c.source, start, end },
        );
      }

      if (!found.length)
        r.note = (await page.locator('body').innerText())
          .replace(/\s+/g, ' ')
          .slice(0, 180);
    } catch (e) {
      r.error = e.message;
    } finally {
      await page.close();
    }
  }
} finally {
  await fs.writeFile(
    'outputs/generic-live-verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
}
