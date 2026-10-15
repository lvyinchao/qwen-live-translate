import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wav } from '../lib/audio';
import {
  mergeAudio,
  mergedScripts,
  pcmSize,
  streamZip,
  type StoredPart,
} from '../lib/merged-audio';
import { MemoryFiles } from './file-store';
const context = {
  mediaId: 'v',
  title: 'merge',
  language: 'zh',
  voice: 'original-auto-v1',
  trackId: 'default',
};
const make = (start: number, end: number, samples: number): StoredPart => ({
  id: String(start),
  key: String(start),
  job: 'v',
  mediaId: 'v',
  language: 'zh',
  voice: context.voice,
  start,
  end,
  sourceText: 'source',
  text: '译文',
  audioDuration: samples / 24000,
  path: `parts/${start}.wav`,
  fingerprint: String(start),
  samples,
});
it('stream-merges PCM once in source order without headers in the audio, truncation or pitch changes', async () => {
  const disk = new MemoryFiles(),
    parts = [make(23, 25.5, 480), make(60, 61, 960)];
  const first = new Uint8Array(960).fill(0x11),
    second = new Uint8Array(1920).fill(0x22);
  disk.files.set(parts[0]!.path, new Blob([new Uint8Array(wav([first]))]));
  disk.files.set(parts[1]!.path, new Blob([new Uint8Array(wav([second]))]));
  await mergeAudio(disk, 'merged.wav', parts);
  const out = new Uint8Array(
    await (await disk.get('merged.wav')).arrayBuffer(),
  );
  expect(out.length).toBe(44 + first.length + second.length);
  expect(new DataView(out.buffer).getUint32(40, true)).toBe(
    first.length + second.length,
  );
  expect(out.slice(44, 44 + first.length)).toEqual(first);
  expect(out.slice(44 + first.length)).toEqual(second);
  const scripts = mergedScripts(context, parts),
    meta = JSON.parse(await scripts[0]!.blob.text());
  expect(meta.duration).toBe(0.06);
  expect(meta.segments[1]).toMatchObject({
    sourceStart: 60,
    sourceEnd: 61,
    audioStart: 0.02,
    audioEnd: 0.06,
  });
  await streamZip(disk, 'result.zip', [
    { name: 'combined.wav', blob: await disk.get('merged.wav') },
    ...scripts,
  ]);
  const folder = mkdtempSync(join(tmpdir(), 'qvd-merge-'));
  try {
    const file = join(folder, 'result.zip');
    writeFileSync(
      file,
      new Uint8Array(await (await disk.get('result.zip')).arrayBuffer()),
    );
    execFileSync('unzip', ['-t', file]);
    expect(execFileSync('unzip', ['-p', file, 'combined.wav'])).toEqual(
      Buffer.from(out),
    );
    expect(
      execFileSync('unzip', ['-p', file, 'combined.srt']).toString(),
    ).toContain('00:00:00,020 --> 00:00:00,060');
    expect(
      execFileSync('unzip', ['-p', file, 'source-subtitles.srt']).toString(),
    ).toContain('00:01:00,000 --> 00:01:01,000');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it('rejects truncated and mismatched WAV chunks rather than silently producing damaged audio', async () => {
  const good = wav([new Uint8Array(100)]);
  await expect(pcmSize(new Blob([good.slice(0, -1)]))).rejects.toThrow('WAV');
  const other = wav([new Uint8Array(100)], 16000);
  await expect(pcmSize(new Blob([new Uint8Array(other)]))).rejects.toThrow(
    'WAV',
  );
});
