import { wav } from './audio';
import { subtitleTime, type ArchiveContext } from './archive';
import { writeBlob, type FileStore } from './file-store';
import type { TranslationSegment } from './types';
export type StoredPart = Omit<TranslationSegment, 'audio'> & {
  key: string;
  job: string;
  path: string;
  fingerprint: string;
  samples: number;
};
export const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
export const textDigest = (value: string) =>
  digest(new TextEncoder().encode(value));
export async function pcmSize(blob: Blob): Promise<number> {
  const header = new Uint8Array(await blob.slice(0, 44).arrayBuffer());
  if (header.length !== 44) throw new Error('无法合并：译音 WAV 格式无效');
  const v = new DataView(header.buffer),
    text = (at: number, n: number) =>
      String.fromCharCode(...header.slice(at, at + n));
  const size = v.getUint32(40, true);
  if (
    text(0, 4) !== 'RIFF' ||
    text(8, 4) !== 'WAVE' ||
    text(12, 4) !== 'fmt ' ||
    text(36, 4) !== 'data' ||
    v.getUint32(16, true) !== 16 ||
    v.getUint16(20, true) !== 1 ||
    v.getUint16(22, true) !== 1 ||
    v.getUint32(24, true) !== 24000 ||
    v.getUint16(34, true) !== 16 ||
    size % 2 ||
    size + 44 !== blob.size
  )
    throw new Error('无法合并：译音 WAV 格式无效');
  return size;
}
export function mergedHeader(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff - 36)
    throw new Error('合并音频超过 WAV 文件上限');
  const header = new Uint8Array(wav([])),
    view = new DataView(header.buffer);
  view.setUint32(4, size + 36, true);
  view.setUint32(40, size, true);
  return header;
}
export async function mergeAudio(
  store: FileStore,
  path: string,
  parts: StoredPart[],
) {
  const total = parts.reduce((n, p) => n + p.samples * 2, 0);
  const header = mergedHeader(total),
    sink = await store.create(path);
  try {
    await sink.write(header);
    for (const part of parts) {
      const file = await store.get(part.path);
      if ((await pcmSize(file)) !== part.samples * 2)
        throw new Error('本地译音片段不完整，无法合并');
      await writeBlob(sink, file.slice(44));
    }
    await sink.close();
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}
export function mergedScripts(context: ArchiveContext, parts: StoredPart[]) {
  let cursor = 0;
  const segments = parts.map((part) => {
    const start = cursor / 24000;
    cursor += part.samples;
    return {
      sourceStart: part.start,
      sourceEnd: part.end,
      audioStart: start,
      audioEnd: cursor / 24000,
      sourceText: part.sourceText,
      translatedText: part.text,
      speaker: part.speaker,
    };
  });
  const srt = (audio: boolean) =>
    segments
      .map(
        (s, i) =>
          `${i + 1}\n${subtitleTime(audio ? s.audioStart : s.sourceStart)} --> ${subtitleTime(audio ? s.audioEnd : s.sourceEnd)}\n${s.translatedText.trim()}\n${s.sourceText.trim()}\n`,
      )
      .join('\n');
  const metadata = {
    schema: 2,
    mediaId: context.mediaId,
    title: context.title,
    language: context.language,
    voice: context.voice,
    trackId: context.trackId,
    completeVideo: false,
    audioFile: 'combined.wav',
    sampleRate: 24000,
    channels: 1,
    duration: cursor / 24000,
    audioTiming:
      'Complete original-voice clips concatenated in source order without speed changes. Source gaps are omitted. Source/video and merged/audio timestamps are recorded separately. Only translated utterances are included.',
    segments,
  };
  return [
    {
      name: 'transcript.json',
      blob: new Blob([JSON.stringify(metadata, null, 2) + '\n'], {
        type: 'application/json',
      }),
    },
    {
      name: 'transcript.txt',
      blob: new Blob([
        context.title +
          '\n\n' +
          segments
            .map(
              (s) =>
                `[video ${subtitleTime(s.sourceStart)} – ${subtitleTime(s.sourceEnd)} | audio ${subtitleTime(s.audioStart)} – ${subtitleTime(s.audioEnd)}]\n${s.sourceText}\n${s.translatedText}\n`,
            )
            .join('\n'),
      ]),
    },
    { name: 'combined.srt', blob: new Blob([srt(true)]) },
    { name: 'source-subtitles.srt', blob: new Blob([srt(false)]) },
  ];
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
async function crcOf(blob: Blob) {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const byte of value)
        crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Stored ZIP, streamed to private disk. Audio is never materialized as one large
// JS ArrayBuffer, even for long videos. Native download receives a disk File.
export async function streamZip(
  store: FileStore,
  path: string,
  entries: { name: string; blob: Blob }[],
) {
  const encoder = new TextEncoder(),
    central: Uint8Array<ArrayBuffer>[] = [];
  const total = entries.reduce(
    (n, e) => n + e.blob.size + 76 + encoder.encode(e.name).length * 2,
    22,
  );
  if (total > 0xffffffff) throw new Error('合并文件超过 ZIP 文件上限');
  const sink = await store.create(path);
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = encoder.encode(entry.name),
        crc = await crcOf(entry.blob),
        size = entry.blob.size;
      const h = new Uint8Array(30 + name.length),
        v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x800, true);
      v.setUint16(12, 0x21, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, size, true);
      v.setUint32(22, size, true);
      v.setUint16(26, name.length, true);
      h.set(name, 30);
      await sink.write(h);
      await writeBlob(sink, entry.blob);
      const d = new Uint8Array(46 + name.length),
        c = new DataView(d.buffer);
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x800, true);
      c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, size, true);
      c.setUint32(24, size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      d.set(name, 46);
      central.push(d);
      offset += h.length + size;
    }
    const centralSize = central.reduce((n, p) => n + p.length, 0);
    for (const part of central) await sink.write(part);
    const end = new Uint8Array(22),
      v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, entries.length, true);
    v.setUint16(10, entries.length, true);
    v.setUint32(12, centralSize, true);
    v.setUint32(16, offset, true);
    await sink.write(end);
    await sink.close();
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}
