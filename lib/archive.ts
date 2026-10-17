import { decode64 } from './audio';
import { VOICE, type PlaybackSession, type TranslationSegment } from './types';

export interface ArchiveContext {
  mediaId: string;
  title: string;
  language: string;
  voice: string;
  trackId: string;
}
export interface ArchiveBatch {
  key: string;
  context: ArchiveContext;
  start: number;
  end: number;
  segments: TranslationSegment[];
  ready: boolean;
}
export interface LocalFileStatus {
  staged?: number;
  pending: number;
  saved: number;
  saving: boolean;
  lastDownloadId?: number;
  lastFilename?: string;
  error?: string;
}
export const EMPTY_FILE_STATUS: LocalFileStatus = {
  pending: 0,
  saved: 0,
  saving: false,
};
export function archiveContext(session: PlaybackSession): ArchiveContext {
  return {
    mediaId: session.candidate.mediaId,
    title: session.candidate.title,
    language: session.language,
    voice: VOICE,
    trackId: session.candidate.source?.trackId ?? 'default',
  };
}
export function archiveKey(context: ArchiveContext, start: number, end: number) {
  return JSON.stringify([
    context.mediaId,
    context.trackId,
    context.language,
    context.voice,
    start,
    end,
  ]);
}
export function subtitleTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
const stamp = (value: number) => String(Math.round(value * 1000)).padStart(10, '0');
const audioName = (segment: TranslationSegment, index: number) =>
  `audio/${stamp(segment.start)}-${stamp(segment.end)}-${index}.wav`;
/** A retried sentence can move by a few samples; simultaneous speakers must survive. */
export function sameArchiveUtterance(
  a: Pick<TranslationSegment, 'start' | 'end' | 'speaker' | 'sourceText' | 'text'>,
  b: Pick<TranslationSegment, 'start' | 'end' | 'speaker' | 'sourceText' | 'text'>,
) {
  if (a.speaker !== b.speaker) return false;
  if (a.start === b.start && a.end === b.end) return true;
  const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const textA = normalize(a.sourceText || a.text),
    textB = normalize(b.sourceText || b.text);
  return (
    textA.length > 0 &&
    textA === textB &&
    Math.abs(a.start - b.start) <= 0.050001 &&
    Math.abs(a.end - b.end) <= 0.050001 &&
    Math.min(a.end, b.end) - Math.max(a.start, b.start) >=
      Math.max(a.end - a.start, b.end - b.start) * 0.8
  );
}
export function mergeArchiveSegments(old: TranslationSegment[], incoming: TranslationSegment[]) {
  const merged: TranslationSegment[] = [];
  for (const segment of [...old, ...incoming]) {
    const duplicate = merged.findIndex((s) => sameArchiveUtterance(s, segment));
    if (duplicate >= 0) merged[duplicate] = segment;
    else merged.push(segment);
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end);
}
export function archiveEntries(
  batch: ArchiveBatch,
): { name: string; bytes: Uint8Array<ArrayBuffer> }[] {
  const encoder = new TextEncoder();
  const segments = mergeArchiveSegments([], batch.segments);
  const text = (name: string, value: string) => ({
    name,
    bytes: encoder.encode(value),
  });
  // Explicitly select exported fields: never serialize candidates, media URLs,
  // request headers, playback settings or provider credentials.
  const metadata = {
    schema: 1,
    mediaId: batch.context.mediaId,
    title: batch.context.title,
    language: batch.context.language,
    voice: batch.context.voice,
    trackId: batch.context.trackId,
    sourceStart: batch.start,
    sourceEnd: batch.end,
    completeVideo: false,
    coverageNote:
      'Contains completed utterances only. The source window may be partially translated or stopped early.',
    audioFormat: 'WAV / mono / 24 kHz / signed 16-bit PCM',
    audioTiming:
      'Unmodified speech clips. Use sourceStart/sourceEnd for the video timeline; clips may be longer than the source utterance.',
    segments: segments.map((s, index) => ({
      sourceStart: s.start,
      sourceEnd: s.end,
      sourceText: s.sourceText,
      translatedText: s.text,
      speaker: s.speaker,
      audioDuration: s.audioDuration,
      audioFile: audioName(s, index),
    })),
  };
  const srt = segments
    .map(
      (s, i) =>
        `${i + 1}\n${subtitleTime(s.start)} --> ${subtitleTime(s.end)}\n${s.text.trim()}\n${s.sourceText.trim()}\n`,
    )
    .join('\n');
  const script =
    `${batch.context.title}\n${batch.context.language} · ${subtitleTime(batch.start)} – ${subtitleTime(batch.end)}\n\n` +
    segments
      .map(
        (s) =>
          `[${subtitleTime(s.start)} – ${subtitleTime(s.end)}]${s.speaker === undefined ? '' : ` Speaker ${s.speaker}`}\n${s.sourceText}\n${s.text}\n`,
      )
      .join('\n');
  return [
    text('transcript.txt', script),
    text('subtitles.srt', srt),
    text('transcript.json', JSON.stringify(metadata, null, 2) + '\n'),
    ...segments.map((s, index) => ({ name: audioName(s, index), bytes: decode64(s.audio) })),
  ];
}

// Standard ZIP (stored entries). Each bundle is bounded to a single input
// window, so no entire-video PCM allocation or third-party ZIP runtime is needed.
export function zipEntries(entries: ReturnType<typeof archiveEntries>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder(),
    local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0,
    centralSize = 0;
  for (const { name, bytes } of entries) {
    const filename = encoder.encode(name);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + filename.length),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, filename.length, true);
    header.set(filename, 30);
    local.push(header, bytes);
    const directory = new Uint8Array(46 + filename.length),
      d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true);
    d.setUint16(14, 0x21, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, bytes.length, true);
    d.setUint32(24, bytes.length, true);
    d.setUint16(28, filename.length, true);
    d.setUint32(42, offset, true);
    directory.set(filename, 46);
    central.push(directory);
    centralSize += directory.length;
    offset += header.length + bytes.length;
  }
  const end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export async function archiveFilename(batch: ArchiveBatch): Promise<string> {
  const identity = JSON.stringify([batch.context.mediaId, batch.context.trackId]);
  const hash = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))),
  ]
    .slice(0, 8)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  const title =
    Array.from(
      batch.context.title
        .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[. ]+|[. ]+$/g, ''),
    )
      .slice(0, 55)
      .join('') || 'video';
  return `TimbraDub/${hash}-${title}/${batch.context.language}-${batch.context.voice}/${stamp(batch.start)}-${stamp(batch.end)}.zip`;
}
