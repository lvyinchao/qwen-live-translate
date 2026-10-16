import { expect, it } from 'vitest';
import {
  RangeMediaCache,
  MEDIA_DISK_LIMIT,
  MEDIA_RANGE_ERRORS,
  type MediaDisk,
} from '../lib/range-media';
function disk() {
  const bytes = new Uint8Array(12 * 1024 ** 2);
  let removed = false;
  return {
    bytes,
    get removed() {
      return removed;
    },
    write: (data: Uint8Array, at: number) => {
      bytes.set(data, at);
      return data.length;
    },
    read: (out: Uint8Array, at: number) => {
      out.set(bytes.subarray(at, at + out.length));
      return out.length;
    },
    remove: async () => {
      removed = true;
    },
  } satisfies MediaDisk & { bytes: Uint8Array; readonly removed: boolean };
}
const request = (start: number, end: number) => ({
  headers: { Range: `bytes=${start}-${end}` },
});
function sequential(
  bytes: Uint8Array,
  headers: HeadersInit = { 'Content-Length': String(bytes.length) },
) {
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (at === bytes.length) {
          c.close();
          return;
        }
        const to = Math.min(at + 65536, bytes.length);
        c.enqueue(bytes.slice(at, to));
        at = to;
      },
    }),
    { headers },
  );
}
it('retains bytes on disk across backward seeks beyond the 8 MiB reader cache and reuses the origin body', async () => {
  const bytes = new Uint8Array(10 * 1024 ** 2);
  for (let at = 0; at < bytes.length; at += 65536)
    bytes.fill((at / 65536) % 251, at, at + 65536);
  const backing = disk();
  let requests = 0;
  const cache = new RangeMediaCache(
    async () => {
      requests++;
      return sequential(bytes);
    },
    async () => backing,
  );
  const tail = await cache.fetch(
    'https://example.test/audio',
    request(bytes.length - 1000, bytes.length - 1),
  );
  expect(tail.status).toBe(206);
  expect(tail.headers.get('Content-Range')).toBe(
    `bytes ${bytes.length - 1000}-${bytes.length - 1}/${bytes.length}`,
  );
  expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-1000));
  const head = await cache.fetch('https://example.test/audio', request(0, 999));
  expect(new Uint8Array(await head.arrayBuffer())).toEqual(
    bytes.slice(0, 1000),
  );
  expect(requests).toBe(1);
  expect(
    (
      await cache.fetch(
        'https://example.test/audio',
        request(bytes.length, bytes.length + 10),
      )
    ).status,
  ).toBe(416);
  await cache.close();
  expect(backing.removed).toBe(true);
});
it('keeps honest 206 responses on the normal fast path without allocating disk', async () => {
  const response = new Response(new Uint8Array([1, 2]), {
    status: 206,
    headers: { 'Content-Range': 'bytes 3-4/20' },
  });
  let created = false;
  const cache = new RangeMediaCache(
    async () => response,
    async () => {
      created = true;
      return disk();
    },
  );
  expect(await cache.fetch('https://example.test/audio', request(3, 4))).toBe(
    response,
  );
  expect(created).toBe(false);
  await cache.close();
});
it('cancelling one virtual range does not discard earlier bytes or destroy the reusable sequential body', async () => {
  const bytes = new Uint8Array(1024 ** 2).fill(87),
    backing = disk();
  let requests = 0;
  const cache = new RangeMediaCache(
    async () => {
      requests++;
      return sequential(bytes);
    },
    async () => backing,
  );
  const abort = new AbortController();
  const response = await cache.fetch('https://example.test/audio', {
    ...request(0, bytes.length - 1),
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  abort.abort();
  await reader.cancel();
  const again = await cache.fetch(
    'https://example.test/audio',
    request(bytes.length - 2, bytes.length - 1),
  );
  expect(new Uint8Array(await again.arrayBuffer())).toEqual(
    new Uint8Array([87, 87]),
  );
  expect(requests).toBe(1);
  await cache.close();
});
it('handles unknown lengths and reports truncated responses, disk exhaustion and size limits explicitly', async () => {
  const unknown = new RangeMediaCache(
    async () => sequential(new Uint8Array([5, 6, 7]), {}),
    async () => disk(),
  );
  expect(
    new Uint8Array(
      await (
        await unknown.fetch('https://x.test/a', request(1, 2))
      ).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([6, 7]));
  await unknown.close();
  const truncated = new RangeMediaCache(
    async () => sequential(new Uint8Array([1, 2]), { 'Content-Length': '10' }),
    async () => disk(),
  );
  await expect(
    (await truncated.fetch('https://x.test/a', request(0, 9))).arrayBuffer(),
  ).rejects.toThrow(MEDIA_RANGE_ERRORS.truncated);
  await truncated.close();
  const backing = disk();
  backing.write = () => {
    throw new DOMException('Full', 'QuotaExceededError');
  };
  const full = new RangeMediaCache(
    async () => sequential(new Uint8Array([1])),
    async () => backing,
  );
  await expect(
    (await full.fetch('https://x.test/a', request(0, 0))).arrayBuffer(),
  ).rejects.toThrow(MEDIA_RANGE_ERRORS.quota);
  await full.close();
  expect(backing.removed).toBe(true);
  const huge = new RangeMediaCache(
    async () =>
      sequential(new Uint8Array(), {
        'Content-Length': String(MEDIA_DISK_LIMIT + 1),
      }),
    async () => disk(),
  );
  await expect(huge.fetch('https://x.test/a', request(0, 10))).rejects.toThrow(
    MEDIA_RANGE_ERRORS.limit,
  );
  await huge.close();
});
it('cleans temporary files after an interrupted origin stream and does not leave reads hanging', async () => {
  const backing = disk();
  const cache = new RangeMediaCache(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(c) {
            init?.signal?.addEventListener(
              'abort',
              () => c.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Length': '100' } },
      ),
    async () => backing,
    15,
  );
  const response = await cache.fetch('https://x.test/a', request(0, 99));
  await expect(response.arrayBuffer()).rejects.toThrow(
    MEDIA_RANGE_ERRORS.timeout,
  );
  await cache.close();
  expect(backing.removed).toBe(true);
});
it('evicts a failed sequential source so an automatic retry can open a healthy origin stream', async () => {
  const disks: ReturnType<typeof disk>[] = [];
  let requests = 0;
  const cache = new RangeMediaCache(
    async () => {
      requests++;
      return requests === 1
        ? new Response(new ReadableStream({ start(c) { c.error(new Error('temporary outage')); } }), { headers: { 'Content-Length': '4' } })
        : sequential(new Uint8Array([1, 2, 3, 4]));
    },
    async () => { const next = disk(); disks.push(next); return next; },
  );
  await expect((await cache.fetch('https://x.test/retry', request(0, 3))).arrayBuffer()).rejects.toThrow('temporary outage');
  expect(new Uint8Array(await (await cache.fetch('https://x.test/retry', request(0, 3))).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(requests).toBe(2);
  await cache.close();
  expect(disks.every((backing) => backing.removed)).toBe(true);
});
