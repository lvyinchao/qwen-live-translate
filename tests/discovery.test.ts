import { it, expect } from 'vitest';
import {
  mediaKind,
  chooseGenericSource,
  type ObservedMedia,
} from '../lib/discovery';
import { safeMediaUrl } from '../lib/security';
import { mediaIdentity } from '../lib/adapters';
const video = {
  url: 'blob:https://v.youku.com/player',
  frameUrl: 'https://v.youku.com/v_show/id_sample.html',
  protected: false,
};
const resource = (
  kind: ObservedMedia['kind'],
  url = 'https://cdn.youku.com/audio.m4a',
): ObservedMedia => ({
  url,
  kind,
  mime: kind === 'file' ? 'audio/mp4' : 'application/octet-stream',
  frameId: 0,
  at: 0,
  headers: { Referer: video.frameUrl },
});
it('detects audio/video, HLS, DASH and media fragments from public CDNs without an audio-only domain list', () => {
  expect(mediaKind('https://cdn.youku.com/x', 'audio/mp4')).toBe('file');
  expect(
    mediaKind(
      'https://cache.iqiyi.com/stream',
      'application/vnd.apple.mpegurl',
    ),
  ).toBe('hls');
  expect(mediaKind('https://video.qq.com/video.mpd?token=private', '')).toBe(
    'dash',
  );
  expect(mediaKind('https://cdn.youku.com/1.m4s', 'video/mp4')).toBe(
    'fragment',
  );
  expect(mediaKind('https://cdn.youku.com/1.ts', 'video/mp2t')).toBe(
    'fragment',
  );
  expect(
    mediaKind('https://cdn.youku.com/tracking', 'application/json'),
  ).toBeUndefined();
});
it('does not accept credential-bearing, local or non-web URLs when supporting other public CDN hosts', () => {
  for (const url of [
    'https://user:pass@cdn.youku.com/a.mp4',
    'https://127.0.0.1/a.mp4',
    'http://cdn.youku.com/a.mp4',
    'https://foo.local/a.mp4',
    'https://[::1]/a.mp4',
    'blob:https://v.youku.com/id',
  ])
    expect(safeMediaUrl(url, true), url).toBe(false);
  expect(safeMediaUrl('https://cdn.youku.com/a.mp4', true)).toBe(true);
  expect(safeMediaUrl('https://cdn.youku.com/a.mp4')).toBe(false);
});
it('matches a direct player URL, or one unambiguous observed audio track, and retains signed parameters', () => {
  const direct = 'https://cdn.youku.com/movie.mp4?signature=keep-me';
  expect(
    chooseGenericSource({ ...video, url: direct }, [], 'page', 2).source?.url,
  ).toBe(direct);
  const chosen = chooseGenericSource(
    video,
    [resource('file')],
    'page',
    1,
  ).source;
  expect(chosen?.url).toBe('https://cdn.youku.com/audio.m4a');
  expect(chosen?.headers?.Referer).toBe(video.frameUrl);
  expect(
    chooseGenericSource(
      video,
      [resource('hls', 'https://cdn.youku.com/movie.m3u8')],
      'page',
      1,
    ).source?.kind,
  ).toBe('hls');
});
it('does not confuse protected players, unrelated playlists or ambiguous videos with ready-to-translate audio', () => {
  expect(
    chooseGenericSource(
      { ...video, protected: true },
      [resource('file')],
      'page',
      1,
    ),
  ).toEqual({ reason: '检测到受保护视频，暂不支持提前翻译' });
  expect(
    chooseGenericSource(video, [resource('dash')], 'page', 1).reason,
  ).toMatch(/DASH/);
  expect(
    chooseGenericSource(
      { ...video, url: 'https://cdn.youku.com/a.mpd' },
      [],
      'page',
      1,
    ).reason,
  ).toMatch(/DASH/);
  expect(
    chooseGenericSource(video, [resource('fragment')], 'page', 1).source,
  ).toBeUndefined();
  expect(
    chooseGenericSource(
      video,
      [resource('file'), resource('file', 'https://cdn.youku.com/other.m4a')],
      'page',
      1,
    ).source,
  ).toBeUndefined();
  expect(
    chooseGenericSource(video, [resource('file')], 'page', 2).source,
  ).toBeUndefined();
});
it('preserves generic hash routes as video identities', () => {
  expect(mediaIdentity('https://www.iqiyi.com/player#episode2')).not.toBe(
    mediaIdentity('https://www.iqiyi.com/player#episode1'),
  );
});
it('does not mistake an isolated ad MP4 for the main segmented video audio', () => {
  const ad = resource('file', 'https://cdn.youku.com/short-ad.mp4');
  ad.mime = 'video/mp4';
  expect(
    chooseGenericSource(video, [ad, resource('fragment')], 'page', 1).source,
  ).toBeUndefined();
  // A direct URL on the selected video remains an explicit association.
  expect(
    chooseGenericSource(
      { ...video, url: ad.url },
      [ad, resource('fragment')],
      'page',
      1,
    ).source?.url,
  ).toBe(ad.url);
});
it('uses a player-associated native playlist even when another player has a protected stream', () => {
  const main = {
    ...resource('hls', 'https://cdn.qq.com/main.m3u8'),
    playerId: 'main',
  };
  const ad = {
    ...resource('hls', 'https://cdn.qq.com/ad.m3u8'),
    playerId: 'ad',
    protected: true,
  };
  expect(
    chooseGenericSource({ ...video, id: 'main' }, [ad, main], 'page', 2).source
      ?.url,
  ).toBe(main.url);
  expect(
    chooseGenericSource({ ...video, id: 'other' }, [main], 'page', 1).source,
  ).toBeUndefined();
});
