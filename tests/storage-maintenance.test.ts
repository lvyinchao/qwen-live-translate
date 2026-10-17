import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { archiveEntries, mergeArchiveSegments, type ArchiveContext } from '../lib/archive';
import { LocalFiles } from '../lib/local-files';
import { encode64, wav } from '../lib/audio';
import type { TranslationSegment } from '../lib/types';
import { MemoryFiles } from './file-store';

const context: ArchiveContext = {
  mediaId: 'generic:one',
  title: 'Video',
  language: 'zh',
  voice: 'original-auto-v1',
  trackId: 'default',
};
const sentence = (changes: Partial<TranslationSegment> = {}): TranslationSegment => ({
  id: 'sentence',
  mediaId: context.mediaId,
  language: context.language,
  voice: context.voice,
  start: 0,
  end: 2,
  speaker: 0,
  sourceText: 'Hello',
  text: '你好',
  audio: encode64(wav([new Uint8Array(480)])),
  audioDuration: 0.01,
  ...changes,
});
const wait = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Archive operation did not settle');
};
it('replaces a slightly shifted retry, reclaims its old WAV and reports actual private storage', async () => {
  const disk = new MemoryFiles();
  const files = new LocalFiles(
    async () => 1,
    () => {},
    crypto.randomUUID(),
    disk,
  );
  files.setAutoSave(true);
  await files.capture(context, 0, 30, [sentence()]);
  const oldPath = [...disk.files.keys()][0]!;
  await files.capture(context, 0, 30, [
    sentence({
      id: 'retry',
      start: 0.02,
      end: 2.02,
      audio: encode64(wav([new Uint8Array(480).fill(1)])),
    }),
  ]);
  expect((await files.status()).staged).toBe(1);
  expect(disk.files.has(oldPath)).toBe(false);
  expect(await files.summary()).toEqual({
    bytes: 524,
    files: 1,
    parts: 1,
    jobs: 1,
    orphanBytes: 0,
  });
});
it('preserves simultaneous speakers and gives overlapping exported WAVs distinct filenames', async () => {
  const a = sentence(),
    b = sentence({ id: 'other', speaker: 1 });
  expect(mergeArchiveSegments([a], [b])).toHaveLength(2);
  expect(
    mergeArchiveSegments([a], [sentence({ start: 0.02, end: 2.02, sourceText: 'Goodbye' })]),
  ).toHaveLength(2);
  const entries = archiveEntries({
    key: 'batch',
    context,
    start: 0,
    end: 30,
    ready: true,
    segments: [a, b],
  });
  expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);
  const disk = new MemoryFiles();
  const files = new LocalFiles(
    async () => 1,
    () => {},
    crypto.randomUUID(),
    disk,
  );
  files.setAutoSave(true);
  await files.capture(context, 0, 30, [a, b]);
  expect((await files.summary()).parts).toBe(2);
  // Both speakers can reference the same immutable content-addressed WAV.
  await files.capture(context, 0, 30, [
    sentence({ audio: encode64(wav([new Uint8Array(480).fill(2)])) }),
  ]);
  expect((await files.summary()).files).toBe(2);
  expect((await files.summary()).parts).toBe(2);
});
it('collects abandoned files on startup and exposes explicit garbage collection', async () => {
  const disk = new MemoryFiles();
  disk.files.set('stale/merged.wav', new Blob(['old']));
  const files = new LocalFiles(
    async () => 1,
    () => {},
    crypto.randomUUID(),
    disk,
  );
  expect((await files.summary()).bytes).toBe(0);
  disk.files.set('orphan/part.wav', new Blob(['orphan']));
  expect((await files.summary()).orphanBytes).toBe(6);
  expect(await files.gc()).toMatchObject({ files: 0, orphanBytes: 0 });
});
it('pins a merge snapshot until it finishes while a replacement and GC run concurrently', async () => {
  const disk = new MemoryFiles();
  const get = disk.get.bind(disk);
  let release: (() => void) | undefined;
  let held = false;
  disk.get = async (path) => {
    if (!held && path.includes('/parts/')) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return get(path);
  };
  const download = vi.fn(async () => 1);
  const files = new LocalFiles(download, () => {}, crypto.randomUUID(), disk);
  files.setAutoSave(true);
  await files.capture(context, 0, 30, [sentence()]);
  const oldPath = [...disk.files.keys()][0]!;
  await files.finish(context);
  await wait(async () => !!release);
  await files.capture(context, 0, 30, [
    sentence({ audio: encode64(wav([new Uint8Array(480).fill(3)])) }),
  ]);
  await files.gc();
  expect(disk.files.has(oldPath)).toBe(true);
  release!();
  await wait(async () => !(await files.status()).saving);
  expect(download).toHaveBeenCalledTimes(1);
  expect((await files.status()).error).toBeUndefined();
  expect(disk.files.has(oldPath)).toBe(false);
  expect((await files.summary()).files).toBe(1);
});
it('clears private archives safely while a merge is preparing and prevents a new download', async () => {
  const disk = new MemoryFiles();
  const get = disk.get.bind(disk);
  let release: (() => void) | undefined;
  let held = false;
  disk.get = async (path) => {
    if (!held && path.includes('/parts/')) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return get(path);
  };
  const download = vi.fn(async () => 1);
  const files = new LocalFiles(download, () => {}, crypto.randomUUID(), disk);
  files.setAutoSave(true);
  await files.capture(context, 0, 30, [sentence()]);
  await files.finish(context);
  await wait(async () => !!release);
  const clearing = files.clear();
  await files.capture(context, 0, 30, [sentence({ start: 4, end: 6 })]);
  release!();
  await clearing;
  expect(download).not.toHaveBeenCalled();
  expect(await files.summary()).toEqual({ bytes: 0, files: 0, parts: 0, jobs: 0, orphanBytes: 0 });
  expect(await files.status()).toMatchObject({ pending: 0, staged: 0, saved: 0, saving: false });
});
it('uses a completed window as authoritative without pruning streaming updates or outside-window sentences', async () => {
  const disk = new MemoryFiles();
  const files = new LocalFiles(
    async () => 1,
    () => {},
    crypto.randomUUID(),
    disk,
  );
  files.setAutoSave(true);
  await files.capture(context, 0, 30, [
    sentence(),
    sentence({ id: 'outside', start: 35, end: 38 }),
  ]);
  const changed = sentence({
    id: 'new-segmentation',
    start: 0.5,
    end: 3,
    sourceText: 'Hello there',
    text: '你好啊',
  });
  await files.capture(context, 0, 30, [changed]);
  expect((await files.summary()).parts).toBe(3);
  await files.capture(context, 0, 30, [changed], true);
  expect((await files.summary()).parts).toBe(2);
  expect((await files.summary()).files).toBe(2);
  await files.capture(context, 0, 30, [], true);
  expect((await files.summary()).parts).toBe(1);
});
it('does not leave an unindexed WAV when a later invalid sentence aborts the same capture', async () => {
  const disk = new MemoryFiles();
  const files = new LocalFiles(
    async () => 1,
    () => {},
    crypto.randomUUID(),
    disk,
  );
  files.setAutoSave(true);
  await expect(
    files.capture(context, 0, 30, [
      sentence(),
      sentence({ id: 'bad', start: 10, end: 11, mediaId: 'other' }),
    ]),
  ).rejects.toThrow('本地译音片段信息无效');
  expect((await files.summary()).files).toBe(0);
  expect((await files.summary()).parts).toBe(0);
});
it('repairs slightly shifted duplicate parts left by an older version before merging', async () => {
  const disk = new MemoryFiles(),
    name = crypto.randomUUID();
  const first = new LocalFiles(
    async () => 1,
    () => {},
    name,
    disk,
  );
  first.setAutoSave(true);
  await first.capture(context, 0, 30, [sentence()]);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['parts', 'jobs'], 'readwrite');
    const parts = tx.objectStore('parts'),
      jobs = tx.objectStore('jobs');
    const request = parts.getAll();
    request.onsuccess = () => {
      const old = request.result[0];
      const path = old.path.replace(/\.wav$/, '-old-version.wav');
      disk.files.set(path, disk.files.get(old.path)!);
      parts.put({
        ...old,
        key: 'old-version-duplicate',
        path,
        start: 0.02,
        end: 2.02,
        storedAt: Date.now() + 1,
      });
      const job = jobs.get(old.job);
      job.onsuccess = () => jobs.put({ ...job.result, count: 2, revision: 2 });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  database.close();
  const restarted = new LocalFiles(
    async () => 1,
    () => {},
    name,
    disk,
  );
  expect(await restarted.summary()).toMatchObject({ parts: 1, files: 1, orphanBytes: 0 });
  expect((await restarted.status()).staged).toBe(1);
});
