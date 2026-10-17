import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectPlayerMain, youtubeDirectTrackId, youtubeSourceMatches } from '../lib/adapters';
import { SegmentCache } from '../lib/cache';
import { VOICE, type TranslationSegment } from '../lib/types';

const audio = (id: string | undefined, bitrate: number, resource = 'asset') => ({
  url: `https://cdn.googlevideo.com/videoplayback?id=${resource}&itag=${bitrate}&expire=100&sig=old`,
  mimeType: 'audio/mp4',
  bitrate,
  ...(id ? { audioTrack: { id, audioIsDefault: id === 'en-original' } } : {}),
});
function fixture(formats: ReturnType<typeof audio>[], initial?: string) {
  let current = initial;
  const response = {
    videoDetails: { videoId: 'fixture', title: 'Audio tracks' },
    streamingData: { adaptiveFormats: formats },
  };
  const player = {
    getPlayerResponse: () => response,
    getAudioTrack: () => (current ? { id: current } : undefined),
    classList: { contains: () => false },
  };
  vi.stubGlobal('window', { ytInitialPlayerResponse: response });
  vi.stubGlobal('location', { href: 'https://www.youtube.com/watch?v=fixture' });
  vi.stubGlobal('document', { title: 'Fixture', querySelector: () => player });
  return {
    response,
    select: (id?: string) => {
      current = id;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
it('selects the native audio track before optimizing bitrate, including same-language variants', async () => {
  fixture(
    [
      audio('en-original', 64000),
      audio('en-original', 32000),
      audio('fr', 12000),
      audio('en-dub', 8000),
    ],
    'en-original',
  );
  const metadata = await inspectPlayerMain();
  expect(metadata.source?.trackId).toBe('en-original');
  expect(metadata.source?.url).toContain('itag=32000');
  expect(metadata.audioSources?.map((source) => source.trackId)).toEqual([
    'en-original',
    'en-original',
  ]);
});
it('uses distinct cache namespaces when the same video changes audio tracks', async () => {
  const f = fixture([audio('en-original', 64000), audio('en-dub', 32000)], 'en-original');
  const original = await inspectPlayerMain();
  f.select('en-dub');
  const dub = await inspectPlayerMain();
  expect(original.identity).toBe(dub.identity);
  expect(original.source?.trackId).not.toBe(dub.source?.trackId);
  const key = (metadata: typeof original) =>
    `${metadata.identity}|audio:${metadata.source!.trackId}`;
  const cache = new SegmentCache(10000, crypto.randomUUID());
  const segment: TranslationSegment = {
    id: 'sentence',
    mediaId: original.identity,
    language: 'zh',
    voice: VOICE,
    start: 0,
    end: 2,
    sourceText: 'Hello',
    text: '你好',
    audio: 'AAA=',
    audioDuration: 1,
  };
  await cache.put(key(original), 'zh', VOICE, { start: 0, end: 30 }, [segment]);
  expect((await cache.load(key(dub), 'zh', VOICE)).segments).toEqual([]);
  expect((await cache.load(key(original), 'zh', VOICE)).segments).toHaveLength(1);
});
it.each([
  { formats: [audio('en-original', 64000), audio('fr', 32000)] },
  { formats: [audio('en-original', 64000), audio(undefined, 32000)] },
  { formats: [audio(undefined, 64000), audio(undefined, 32000)] },
])(
  'does not guess the selected audio language when multiple anonymous or distinct tracks are ambiguous',
  async ({ formats }) => {
    fixture(formats);
    const metadata = await inspectPlayerMain();
    expect(metadata.source).toBeUndefined();
    expect(metadata.audioSources).toEqual([]);
    expect(metadata.sourceReason).toContain('当前音轨');
  },
);
it('does not substitute a different or anonymous track when the native selected ID is unavailable in formats', async () => {
  fixture([audio('fr', 16000), audio(undefined, 32000)], 'en-original');
  expect((await inspectPlayerMain()).source).toBeUndefined();
});
it('can select a uniquely identified audio group when the native getter is absent', async () => {
  fixture([audio('en-original', 64000), audio('en-original', 32000)]);
  expect((await inspectPlayerMain()).source?.trackId).toBe('en-original');
});
it('isolates a single anonymous resource by hash while tolerating expiry/signature renewal', async () => {
  const f = fixture([audio(undefined, 64000, 'a')]);
  const first = await inspectPlayerMain();
  f.response.streamingData.adaptiveFormats[0]!.url = audio(undefined, 64000, 'a').url.replace(
    'expire=100&sig=old',
    'expire=200&sig=new',
  );
  const renewed = await inspectPlayerMain();
  f.response.streamingData.adaptiveFormats[0]!.url = audio(undefined, 64000, 'b').url;
  const replaced = await inspectPlayerMain();
  expect(first.source?.trackId).toMatch(/^yt-direct:[a-f0-9]{64}$/);
  expect(renewed.source?.trackId).toBe(first.source?.trackId);
  expect(replaced.source?.trackId).not.toBe(first.source?.trackId);
});
it('matches observed direct reads to verified current formats and rejects legacy or former-track sources', async () => {
  fixture([audio('en-original', 64000), audio('fr', 32000)], 'en-original');
  const metadata = await inspectPlayerMain();
  const url =
    audio('en-original', 64000).url.replace('sig=old', 'sig=renewed') + '&range=0-99&rn=1';
  expect(youtubeDirectTrackId(url, metadata)).toBe('en-original');
  expect(youtubeDirectTrackId(audio('fr', 32000).url, metadata)).toBeUndefined();
  expect(youtubeSourceMatches({ ...metadata.source!, trackId: 'default' }, metadata)).toBe(false);
  expect(youtubeSourceMatches({ ...metadata.source!, trackId: 'fr' }, metadata)).toBe(false);
  expect(youtubeSourceMatches(metadata.source!, metadata)).toBe(true);
});
it('accepts an explicit request track only when it equals the native current track ID', async () => {
  fixture([], 'en-original');
  const metadata = await inspectPlayerMain();
  expect(
    youtubeDirectTrackId(
      'https://cdn.googlevideo.com/videoplayback?audio_track_id=en-original',
      metadata,
    ),
  ).toBe('en-original');
  expect(
    youtubeDirectTrackId('https://cdn.googlevideo.com/videoplayback?audio_track_id=fr', metadata),
  ).toBeUndefined();
});
