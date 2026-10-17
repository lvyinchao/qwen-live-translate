import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const extension = await fs.mkdtemp(path.resolve('work/extension-snapshot-'));
await fs.cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
const context = await chromium.launchPersistentContext(
  await fs.mkdtemp(path.resolve('work/sites-browser-')),
  {
    channel: 'chromium',
    headless: false,
    timeout: 25000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  },
);
const records = [];
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await sw.evaluate(() => true);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const decode = (await fs.readdir(path.join(extension, 'assets'))).find((f) =>
    f.startsWith('decode-'),
  );
  let urls = [
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://www.youtube.com/watch?v=RKK7wGAYP6k',
    'https://www.bilibili.com/video/BV13rsaeaEgE/',
    'https://www.bilibili.com/video/BV1ES4y157iR/',
  ];
  if (process.env.VIDEO_URL) urls = [process.env.VIDEO_URL];
  for (const url of urls.filter(
    (url) => !process.env.SITE_FILTER || url.includes(process.env.SITE_FILTER),
  )) {
    const page = await context.newPage();
    const record = { url, at: new Date().toISOString() };
    records.push(record);
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      record.status = response?.status();
      await page.waitForTimeout(5000);
      record.title = await page.title();
      record.playability = await page.evaluate(() => {
        try {
          return (
            document.querySelector('#movie_player')?.getPlayerResponse?.()?.playabilityStatus
              ?.reason ??
            document.querySelector('.ytp-error-content-wrap')?.textContent ??
            null
          );
        } catch {
          return null;
        }
      });
      await page.locator('video').first().waitFor({ state: 'attached', timeout: 10000 });
      await page
        .locator('video')
        .first()
        .evaluate((v) => {
          v.muted = true;
          void v.play().catch(() => {});
        });
      await page.waitForTimeout(
        url.includes('youtube') ? Number(process.env.NATIVE_PLAY_MS ?? 1000) : 6000,
      );
      const autoplay = page.locator('.ytp-autonav-toggle-button[aria-checked="true"]');
      if (await autoplay.count())
        await autoplay
          .first()
          .click({ timeout: 500 })
          .catch(() => {});
      for (
        let attempt = 0;
        attempt < 45 && (await page.locator('#movie_player.ad-showing').count());
        attempt++
      ) {
        const skip = page.locator(
          '.ytp-skip-ad-button,.ytp-ad-skip-button-modern,.ytp-ad-skip-button',
        );
        if (await skip.count())
          await skip
            .first()
            .click({ timeout: 500 })
            .catch(() => {});
        await page.waitForTimeout(500);
      }
      record.nativePlayer = await page
        .locator('video')
        .first()
        .evaluate((v) => ({
          position: v.currentTime,
          paused: v.paused,
          readyState: v.readyState,
          error: v.error?.code,
          buffered: Array.from({ length: v.buffered.length }, (_, i) => [
            v.buffered.start(i),
            v.buffered.end(i),
          ]),
        }));
      const candidates = await panel.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        if (!tab) return { ok: false, error: 'tab not found' };
        return chrome.runtime.sendMessage({
          target: 'background',
          type: 'media:discover',
          tabId: tab.id,
        });
      }, url);
      record.capture = await panel.evaluate(() =>
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'media:diagnostics',
        }),
      );
      if (!candidates.ok) throw new Error(candidates.error);
      const candidate = candidates.value[0];
      record.candidates = candidates.value.map((c) => ({
        site: c.site,
        duration: c.duration,
        width: c.width,
        height: c.height,
        sourceStatus: c.sourceStatus,
        ad: c.ad,
        mime: c.source?.mime,
        host: c.source ? new URL(c.source.url).hostname : undefined,
      }));
      if (!candidate?.source) throw new Error('no prefetchable audio source');
      await page
        .locator('video')
        .first()
        .evaluate((v) => v.pause());
      const before = await page
        .locator('video')
        .first()
        .evaluate((v) => v.currentTime);
      const start = process.env.EXTRACT_PCM
          ? 0
          : process.env.WINDOW_START
            ? Number(process.env.WINDOW_START)
            : Math.min(candidate.duration - 3, before + 60),
        end = process.env.EXTRACT_PCM ? 30 : start + Number(process.env.WINDOW_SIZE ?? 3);
      record.prefetch = await panel.evaluate(
        async ({ source, decode, start, end, dump }) => {
          const result = await chrome.runtime.sendMessage({
            target: 'background',
            type: 'media:headers',
            source,
          });
          if (!result.ok) return result;
          return await new Promise((resolve) => {
            const worker = new Worker(chrome.runtime.getURL('assets/' + decode), {
              type: 'module',
            });
            const timer = setTimeout(() => {
              worker.terminate();
              resolve({ ok: false, error: 'decode timeout' });
            }, 55000);
            worker.onmessage = (e) => {
              clearTimeout(timer);
              worker.terminate();
              if (!e.data.ok) return resolve(e.data);
              const samples = new Float32Array(e.data.samples);
              let raw;
              if (dump) {
                let binary = '';
                const bytes = new Uint8Array(e.data.samples);
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                raw = btoa(binary);
              }
              resolve({
                raw,
                ok: true,
                samples: samples.length,
                rms: Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length),
                window: [start, end],
                decodedStart: e.data.decodedStart,
                decodedEnd: e.data.decodedEnd,
              });
            };
            worker.onerror = () => {
              clearTimeout(timer);
              worker.terminate();
              resolve({ ok: false, error: 'worker error' });
            };
            worker.postMessage({
              id: 'probe',
              type: 'decode',
              source,
              start,
              end,
            });
          });
        },
        {
          source: candidate.source,
          decode,
          start,
          end,
          dump: !!process.env.EXTRACT_PCM,
        },
      );
      if (record.prefetch.raw) {
        await fs.writeFile('work/native-source.f32', Buffer.from(record.prefetch.raw, 'base64'));
        delete record.prefetch.raw;
      }
      const after = await page
        .locator('video')
        .first()
        .evaluate((v) => v.currentTime);
      record.pausedDuringPrefetch = Math.abs(after - before) < 0.02;
    } catch (error) {
      record.error = error.message.replace(/https?:\/\/[^\s]+\?[^\s]+/g, '[media url]');
    }
    await fs.writeFile(
      `work/gate-sites${process.env.SITE_FILTER ? '-' + process.env.SITE_FILTER : ''}.json`,
      JSON.stringify(records, null, 2),
    );
    console.log(JSON.stringify(record));
    await page.close();
  }
} finally {
  await context.close();
}
