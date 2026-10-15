import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveContext,
  archiveEntries,
  archiveFilename,
  archiveKey,
  zipEntries,
  type ArchiveBatch,
  type ArchiveContext,
} from '../lib/archive';
import { LocalFiles } from '../lib/local-files';
import { MemoryFiles } from './file-store';
import { encode64, wav } from '../lib/audio';
import type { PlaybackSession, TranslationSegment } from '../lib/types';

const context: ArchiveContext = {
  mediaId: 'video:1',
  title: '../演示 / test:*',
  language: 'zh',
  voice: 'original-auto-v1',
  trackId: 'default',
};
const segment: TranslationSegment = {
  id: 'a',
  mediaId: context.mediaId,
  language: 'zh',
  voice: context.voice,
  start: 60.1236,
  end: 63.456,
  sourceText: 'Hello',
  text: '你好',
  speaker: 0,
  audio: encode64(wav([new Uint8Array(480)])),
  audioDuration: 0.01,
};
const batch: ArchiveBatch = {
  key: archiveKey(context, 60, 90),
  context,
  start: 60,
  end: 90,
  segments: [segment],
  ready: true,
};
const wait = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('File queue did not settle');
};
it('writes a standard ZIP with exact WAV bytes, source-timed bilingual scripts and no credentials', async () => {
  const safe = archiveContext({
    candidate: {
      mediaId: 'video:1',
      title: 'test',
      source: {
        trackId: 'default',
        url: 'https://secret.invalid/?signature=hidden',
        headers: { Authorization: 'secret' },
      },
    },
    language: 'zh',
  } as unknown as PlaybackSession);
  expect(JSON.stringify(safe)).not.toMatch(/signature|Authorization|secret/);
  const folder = mkdtempSync(join(tmpdir(), 'qvd-archive-test-'));
  try {
    const file = join(folder, 'archive.zip');
    writeFileSync(file, zipEntries(archiveEntries(batch)));
    execFileSync('unzip', ['-t', file]);
    const transcript = JSON.parse(
      execFileSync('unzip', ['-p', file, 'transcript.json']).toString(),
    );
    expect(transcript.completeVideo).toBe(false);
    expect(transcript.segments[0]).toMatchObject({
      sourceStart: 60.1236,
      sourceEnd: 63.456,
      sourceText: 'Hello',
      translatedText: '你好',
      speaker: 0,
      audioDuration: 0.01,
    });
    expect(
      execFileSync('unzip', ['-p', file, 'subtitles.srt']).toString(),
    ).toContain('00:01:00,124 --> 00:01:03,456\n你好\nHello');
    expect(
      execFileSync('unzip', ['-p', file, transcript.segments[0].audioFile]),
    ).toEqual(Buffer.from(wav([new Uint8Array(480)])));
    const filename = await archiveFilename(batch);
    expect(filename.split('/')).toHaveLength(4);
    expect(filename.split('/').some((p) => p === '..')).toBe(false);
    expect(filename).not.toMatch(/[<>:"\\|?*]/);
    expect(
      await archiveFilename({
        ...batch,
        context: { ...context, language: 'en' },
      }),
    ).not.toBe(filename);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it('retains failed downloads across restart and deduplicates successful retries', async () => {
  const name = crypto.randomUUID(),
    failed = vi.fn(async () => {
      throw new Error('disk full');
    });
  const disk = new MemoryFiles();
  const files = new LocalFiles(failed, () => {}, name, disk);
  await files.capture(context, 60, 90, [segment], true);
  expect(failed).not.toHaveBeenCalled();
  await files.finish(context);
  await wait(async () => !!(await files.status()).error);
  expect((await files.status()).pending).toBe(1);
  const download = vi.fn(async () => 42);
  const restarted = new LocalFiles(download, () => {}, name, disk);
  await restarted.flush();
  expect(download).not.toHaveBeenCalled();
  await restarted.retry();
  await wait(
    async () =>
      (await restarted.status()).saved === 1 &&
      !(await restarted.status()).saving,
  );
  expect((await restarted.status()).pending).toBe(0);
  await restarted.capture(context, 60, 90, [segment], true);
  await restarted.finish(context);
  await wait(
    async () =>
      (await restarted.status()).pending === 0 &&
      !(await restarted.status()).saving,
  );
  expect(download).toHaveBeenCalledTimes(1);
});
it('flushes completed utterances from unfinished windows and keeps updates arriving during a download', async () => {
  let release!: () => void;
  const download = vi.fn(async (_url: string, _filename: string) => {
    if (download.mock.calls.length === 1)
      await new Promise<void>((r) => {
        release = r;
      });
    return 10;
  });
  const files = new LocalFiles(
    download,
    () => {},
    crypto.randomUUID(),
    new MemoryFiles(),
  );
  await files.capture(context, 60, 90, [segment]);
  expect(download).not.toHaveBeenCalled();
  await files.flush();
  expect(download).not.toHaveBeenCalled();
  await files.finish(context);
  await wait(async () => !!release);
  await files.capture(
    context,
    60,
    90,
    [{ ...segment, id: 'b', start: 65, end: 66, text: '后续' }],
    true,
  );
  await files.finish(context);
  release();
  await wait(
    async () =>
      (await files.status()).pending === 0 && !(await files.status()).saving,
  );
  expect(download).toHaveBeenCalledTimes(2);
  expect(new Set(download.mock.calls.map((args) => args[1])).size).toBe(2);
});
