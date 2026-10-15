import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { SegmentCache } from '../lib/cache';
import type { TranslationSegment } from '../lib/types';
const segment = (id: string): TranslationSegment => ({
  id,
  mediaId: 'v',
  language: 'zh',
  voice: 'Tina',
  start: 0,
  end: 2,
  sourceText: 'Hi',
  text: '你好',
  audio: 'A'.repeat(500),
  audioDuration: 1,
});
it('keeps language/voice isolated, persists silent coverage and clears data', async () => {
  const cache = new SegmentCache(10000, crypto.randomUUID());
  await cache.put('v', 'zh', 'Tina', { start: 0, end: 30 }, [segment('a')]);
  await cache.put('v', 'en', 'Tina', { start: 30, end: 60 }, []);
  expect((await cache.load('v', 'zh', 'Tina')).ranges).toEqual([
    { start: 0, end: 30 },
  ]);
  expect((await cache.load('v', 'en', 'Tina')).segments).toEqual([]);
  await cache.clear();
  expect(await cache.size()).toBe(0);
});
it('evicts least-recently-used windows rather than growing without a bound', async () => {
  const cache = new SegmentCache(1700, crypto.randomUUID());
  await cache.put('v', 'zh', 'Tina', { start: 0, end: 30 }, [segment('a')]);
  await cache.put('v', 'zh', 'Tina', { start: 30, end: 60 }, [segment('b')]);
  expect(await cache.size()).toBeLessThanOrEqual(1700);
  expect((await cache.load('v', 'zh', 'Tina')).ranges).toEqual([
    { start: 30, end: 60 },
  ]);
});
it('keeps the byte budget when two translation lanes commit concurrently', async () => {
  const cache = new SegmentCache(6000, crypto.randomUUID());
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      cache.put('v', 'zh', 'Tina', { start: i * 2, end: i * 2 + 2 }, [
        { ...segment(String(i)), start: i * 2, end: i * 2 + 2 },
      ]),
    ),
  );
  expect(await cache.size()).toBeLessThanOrEqual(6000);
  const data = await cache.load('v', 'zh', 'Tina');
  expect(data.segments.length).toBeGreaterThan(0);
  expect(data.segments.length).toBeLessThan(12);
});
