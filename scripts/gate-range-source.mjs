import { isolatedTestEnv } from './test-environment.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
await fs.mkdir('work', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('work/range-source-gate-'));
const extension = path.join(directory, 'extension');
await fs.cp('.output/chrome-mv3', extension, { recursive: true });
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest.content_security_policy.extension_pages =
  manifest.content_security_policy.extension_pages.replace(
    "connect-src 'self' https:",
    "connect-src 'self' http://127.0.0.1:* https:",
  );
await fs.writeFile(manifestPath, JSON.stringify(manifest));
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=12',
  '-c:a',
  'aac',
  '-b:a',
  '96k',
  '-y',
  path.join(directory, 'small.m4a'),
]);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  path.join(directory, 'small.m4a'),
  '-c:a',
  'copy',
  '-hls_time',
  '4',
  '-hls_playlist_type',
  'vod',
  '-hls_flags',
  'program_date_time',
  '-hls_segment_filename',
  path.join(directory, 'hls-%02d.ts'),
  path.join(directory, 'hls.m3u8'),
]);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=1240',
  '-c:a',
  'aac',
  '-b:a',
  '32k',
  '-y',
  path.join(directory, 'long.m4a'),
]);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  path.join(directory, 'long.m4a'),
  '-c:a',
  'copy',
  '-hls_time',
  '10',
  '-hls_playlist_type',
  'vod',
  '-hls_segment_filename',
  path.join(directory, 'hls-long-%03d.ts'),
  path.join(directory, 'hls-long.m3u8'),
]);
const hlsFiles = Object.fromEntries(
  await Promise.all(
    (await fs.readdir(directory))
      .filter((n) => n.startsWith('hls'))
      .map(async (n) => ['/' + n, await fs.readFile(path.join(directory, n))]),
  ),
);
const small = await fs.readFile(path.join(directory, 'small.m4a'));
const long = await fs.readFile(path.join(directory, 'long.m4a'));
let moov = -1;
for (let at = 0; at < small.length; ) {
  const size = small.readUInt32BE(at);
  assert.ok(size >= 8);
  if (small.toString('ascii', at + 4, at + 8) === 'moov') {
    moov = at;
    break;
  }
  at += size;
}
assert.ok(moov > 0);
// Metadata lives behind >8 MiB padding, while sample bytes remain at the front.
// This deterministically forces the same backwards read as the reported CDN bug.
const padding = Buffer.alloc(10 * 1024 ** 2);
padding.writeUInt32BE(padding.length, 0);
padding.write('free', 4);
const fixture = Buffer.concat([
  small.subarray(0, moov),
  padding,
  small.subarray(moov),
]);
const requests = [];
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  requests.push({ path: req.url, range });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges',
  );
  res.setHeader('Content-Type', 'audio/mp4');
  if (hlsFiles[req.url]) {
    res.setHeader(
      'Content-Type',
      req.url.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t',
    );
    res.writeHead(200, { 'Content-Length': hlsFiles[req.url].length });
    res.end(hlsFiles[req.url]);
    return;
  }
  const bytes =
    req.url === '/long.m4a' ? long : req.url === '/short.m4a' ? small : fixture;
  if (
    (req.url === '/honest.m4a' ||
      req.url === '/long.m4a' ||
      req.url === '/short.m4a') &&
    range
  ) {
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    assert.ok(match);
    const start = Number(match[1]),
      end = Math.min(Number(match[2] || bytes.length - 1), bytes.length - 1);
    if (start >= bytes.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': end - start + 1,
    });
    res.end(bytes.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'Content-Length': fixture.length });
    res.end(fixture);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(
  path.join(directory, 'profile'),
  {
    env: isolatedTestEnv(),
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  },
);
const report = {
  at: new Date().toISOString(),
  scope:
    'Real Chrome worker, synthetic AAC/MP4 with tail metadata beyond the 8 MiB cache; localhost 200/206 HTTP responses; no model call',
  fixtureBytes: fixture.length,
  checks: [],
  cases: [],
};
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/THIRD_PARTY_NOTICES.md`);
  const workerFile = (await fs.readdir(path.join(extension, 'assets'))).find(
    (f) => /^decode-.*\.js$/.test(f),
  );
  const inlinePlaylist = await fs.readFile(
    path.join(directory, 'hls.m3u8'),
    'utf8',
  );
  const run = async (asset, cases, graceful = true) =>
    setup.evaluate(
      async ({ asset, cases, base, inlinePlaylist, graceful }) => {
        const worker = new Worker(chrome.runtime.getURL('assets/' + asset), {
          type: 'module',
        });
        const results = [];
        try {
          for (const [index, test] of cases.entries()) {
            const result = await new Promise((resolve) => {
              const timer = setTimeout(
                () => resolve({ ok: false, error: 'decode timeout' }),
                35000,
              );
              worker.onmessage = (e) => {
                if (e.data.id !== String(index)) return;
                clearTimeout(timer);
                const data = e.data;
                if (data.ok) {
                  const pcm = new Float32Array(data.samples);
                  let power = 0;
                  for (const n of pcm) power += n * n;
                  const hash = crypto.subtle
                    .digest('SHA-256', data.samples)
                    .then((b) =>
                      Array.from(new Uint8Array(b), (v) =>
                        v.toString(16).padStart(2, '0'),
                      ).join(''),
                    );
                  hash.then((hash) =>
                    resolve({
                      ok: true,
                      decodedStart: data.decodedStart,
                      decodedEnd: data.decodedEnd,
                      length: pcm.length,
                      rms: Math.sqrt(power / pcm.length),
                      hash,
                    }),
                  );
                } else resolve({ ok: false, error: data.error });
              };
              worker.onerror = (e) => {
                clearTimeout(timer);
                resolve({ ok: false, error: e.message });
              };
              worker.postMessage({
                id: String(index),
                type: 'decode',
                source: {
                  url: base + test.path,
                  kind: test.kind,
                  hlsManifest: test.inline ? inlinePlaylist : undefined,
                  identity: 'range-fixture',
                },
                start: test.start,
                end: test.end,
                expectedDuration: test.expectedDuration,
              });
            });
            results.push({ ...test, ...result });
          }
        } finally {
          if (graceful) {
            const shutdown = await new Promise((resolve) => {
              const timer = setTimeout(
                () => resolve({ ok: false, error: 'Worker shutdown timeout' }),
                2500,
              );
              worker.addEventListener('message', (event) => {
                if (event.data.type !== 'shutdown') return;
                clearTimeout(timer);
                resolve(event.data);
              });
              worker.postMessage({ type: 'shutdown', id: 'shutdown' });
            });
            worker.terminate();
            if (!shutdown.ok) throw new Error(shutdown.error);
          } else worker.terminate();
        }
        return results;
      },
      { asset, cases, base, inlinePlaylist, graceful },
    );
  const case0 = { path: '/ignored.m4a', start: 1, end: 3 };
  if (process.env.BASELINE_DIR) {
    const assets = path.resolve(process.env.BASELINE_DIR, 'assets');
    const original = (await fs.readdir(assets)).find((f) =>
      /^decode-.*\.js$/.test(f),
    );
    // Include dependencies of the old worker under their original hashed names.
    await fs.cp(assets, path.join(extension, 'assets'), {
      recursive: true,
      force: false,
    });
    const [failure] = await run(original, [case0], false);
    report.baseline = failure;
    assert.equal(failure.ok, false);
    assert.match(failure.error, /already-evicted/);
    report.checks.push(
      'Unmodified 0.1.3 reproduced the exact already-evicted cache error',
    );
    report.baselineRequests = requests.splice(0);
  }
  const cases = await run(workerFile, [
    case0,
    { path: '/ignored.m4a', start: 8, end: 11 },
    { path: '/ignored-b.m4a', start: 2, end: 4 },
    case0,
    { path: '/honest.m4a', start: 1, end: 3 },
    { path: '/hls.m3u8', kind: 'hls', start: 2, end: 4 },
    { path: '/inline.m3u8', kind: 'hls', inline: true, start: 2, end: 4 },
    { path: '/long.m4a', start: 1180.15, end: 1210.15, expectedDuration: 1240 },
    { path: '/long.m4a', start: 120, end: 150, expectedDuration: 1240 },
    { path: '/long.m4a', start: 1180.15, end: 1210.15, expectedDuration: 1240 },
    {
      path: '/hls-long.m3u8',
      kind: 'hls',
      start: 1180.15,
      end: 1210.15,
      expectedDuration: 1240,
    },
  ]);
  report.cases = cases;
  for (const c of cases) {
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.ok(c.rms > 0.05);
    assert.equal(c.length, Math.ceil((c.end - c.start) * 16000));
  }
  assert.equal(cases[0].hash, cases[3].hash);
  assert.equal(cases[0].hash, cases[4].hash);
  assert.equal(requests.filter((r) => r.path === '/ignored.m4a').length, 1);
  report.checks.push(
    'Fixed worker decoded future windows and rewound correctly from OPFS with only one 200 origin request',
  );
  report.checks.push(
    'A second disk-backed resource did not evict or delete the first live temporary file',
  );
  assert.equal(requests.filter((r) => r.path === '/inline.m3u8').length, 0);
  report.checks.push(
    'Inline HLS metadata decoded without re-requesting a playlist URL',
  );
  report.checks.push(
    'Unencrypted HLS VOD playlist and audio segments decoded through the same worker',
  );
  report.checks.push(
    'PCM samples from the 200 disk path exactly matched normal 206 range decoding',
  );
  assert.equal(cases[7].hash, cases[9].hash);
  report.checks.push(
    'Full-length MP4 and HLS both decode 1180.15–1210.15 seconds; MP4 also seeks backward and forward without rebasing timestamps',
  );
  const [short] = await run(workerFile, [
    {
      path: '/short.m4a',
      start: 1180.15,
      end: 1210.15,
      expectedDuration: 1240,
    },
  ]);
  assert.equal(short.ok, false);
  assert.match(short.error, /短于当前视频/);
  report.rejectedShortResource = short;
  report.checks.push(
    'Rejects a short unrelated file before translation, rather than shifting its timestamps into the requested window',
  );
  const afterTermination = await setup.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('qwen-video-dub-media-tmp');
    const names = [];
    for await (const [n] of d.entries()) names.push(n);
    return names.length;
  });
  const [restarted] = await run(workerFile, [case0]);
  assert.equal(restarted.ok, true);
  const afterRestart = await setup.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('qwen-video-dub-media-tmp');
    const names = [];
    for await (const [n] of d.entries()) names.push(n);
    return names.length;
  });
  assert.equal(afterTermination, 0);
  assert.equal(afterRestart, 0);
  report.checks.push(
    'Graceful worker shutdown removes all original-media files before termination',
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  throw error;
} finally {
  report.requests = requests;
  await fs.writeFile(
    'outputs/range-source-verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
