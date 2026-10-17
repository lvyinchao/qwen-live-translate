import { describe, expect, it } from 'vitest';
import { canonicalMediaResource, mediaResourceIdentity } from '../lib/media-identity';
import { SegmentCache } from '../lib/cache';
import 'fake-indexeddb/auto';
import { mediaIdentity } from '../lib/adapters';

const page = 'https://video.site/watch';
const source = (url: string) => ({ url, identity: page });
describe('selected media identity', () => {
  it('does not treat similarly named unrelated domains as native platforms', () => {
    expect(mediaIdentity('https://notyoutube.com/watch?v=one')).toBe(
      'https://notyoutube.com/watch?v=one',
    );
    expect(mediaIdentity('https://evilbilibili.com/video/clip')).toBe(
      'https://evilbilibili.com/video/clip',
    );
  });
  it('isolates different clips on one page and across frames', async () => {
    const a = await mediaResourceIdentity(page, page, source('https://cdn.site/a.mp4'));
    const b = await mediaResourceIdentity(page, page, source('https://cdn.site/b.mp4'));
    const frame = await mediaResourceIdentity(
      page,
      'https://embed.site/other',
      source('https://cdn.site/a.mp4'),
    );
    expect(new Set([a, b, frame]).size).toBe(3);
    const cache = new SegmentCache(10000, crypto.randomUUID());
    await cache.put(a, 'zh', 'original', { start: 0, end: 30 }, []);
    expect((await cache.load(b, 'zh', 'original')).ranges).toEqual([]);
  });
  it('retains content parameters and opaque asset tokens, but survives known signature renewal', async () => {
    const a = source('https://cdn.site/a.mp4?vid=one&expires=1&signature=old');
    const b = source('https://cdn.site/a.mp4?signature=new&expires=2&vid=one');
    expect(await mediaResourceIdentity(page, page, a)).toBe(
      await mediaResourceIdentity(page, page, b),
    );
    expect(await mediaResourceIdentity(page, page, a)).not.toBe(
      await mediaResourceIdentity(page, page, source('https://cdn.site/a.mp4?vid=two')),
    );
    expect(canonicalMediaResource('https://cdn.site/play?token=clip-one')).not.toBe(
      canonicalMediaResource('https://cdn.site/play?token=clip-two'),
    );
  });
  it('separates inline playlists behind the same URL and keeps ordinary URL identity deterministic', async () => {
    const a = {
      ...source('https://cdn.site/playlist.m3u8'),
      hlsManifest: '#EXTM3U\nclip-a.ts\n#EXT-X-ENDLIST',
    };
    const b = { ...a, hlsManifest: '#EXTM3U\nclip-b.ts\n#EXT-X-ENDLIST' };
    expect(await mediaResourceIdentity(page, page, a)).not.toBe(
      await mediaResourceIdentity(page, page, b),
    );
    expect(await mediaResourceIdentity(page, page, a)).toBe(
      await mediaResourceIdentity(page, page, a),
    );
    const timed = { ...a, hlsManifest: '#EXTM3U\n#EXTINF:5,\nclip-a.ts\n#EXT-X-ENDLIST' };
    expect(await mediaResourceIdentity(page, page, timed)).not.toBe(
      await mediaResourceIdentity(page, page, {
        ...timed,
        hlsManifest: timed.hlsManifest.replace('EXTINF:5', 'EXTINF:8'),
      }),
    );
    expect(
      await mediaResourceIdentity(page, page, {
        ...timed,
        hlsManifest: '#EXTM3U\n#EXT-X-MAP:URI="init-a.mp4"\nclip-a.ts',
      }),
    ).not.toBe(
      await mediaResourceIdentity(page, page, {
        ...timed,
        hlsManifest: '#EXTM3U\n#EXT-X-MAP:URI="init-b.mp4"\nclip-a.ts',
      }),
    );
  });
});
