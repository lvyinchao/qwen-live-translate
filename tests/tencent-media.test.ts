import { expect, it } from 'vitest';
import { parseTencentMedia, tencentInfoEndpoint } from '../lib/tencent-media';
const page = 'https://v.qq.com/x/cover/cid/z4102cn0lk3.html';
function body(
  playlist = '#EXTM3U\n#EXTINF:5,\nsegment.ts?token=keep\n#EXT-X-ENDLIST',
  changes = {},
) {
  return JSON.stringify({
    vinfo: JSON.stringify({
      vl: {
        vi: [
          {
            vid: 'z4102cn0lk3',
            drm: 0,
            enc: '0',
            ul: {
              m3u8: playlist,
              ui: [{ url: 'https://ltscsy.qq.com/path/index.m3u8?signature=keep' }],
            },
            ...changes,
          },
        ],
      },
    }),
  });
}
it('extracts only the matching Tencent video playlist and preserves returned signed media references', () => {
  const media = parseTencentMedia(body(), page)!;
  expect(media.videoId).toBe('z4102cn0lk3');
  expect(media.protected).toBe(false);
  expect(media.url).toContain('signature=keep');
  expect(media.playlist).toContain('token=keep');
  expect(Object.keys(media).sort()).toEqual(['playlist', 'protected', 'url', 'videoId']);
});
it('rejects other episodes, other pages, malformed and oversized metadata', () => {
  expect(parseTencentMedia(body(), page.replace('z4102cn0lk3', 'other'))).toBeUndefined();
  expect(parseTencentMedia(body(), 'https://v.qq.com.evil.test/z4102cn0lk3.html')).toBeUndefined();
  expect(parseTencentMedia('not-json', page)).toBeUndefined();
  expect(
    parseTencentMedia(
      JSON.stringify({
        data: {
          playInfo: { vid: 'z4102cn0lk3' },
          proxyhttp: { enc: 1, vinfo: 'encoded' },
        },
      }),
      page,
    ),
  ).toBeUndefined();
  expect(parseTencentMedia(' '.repeat(2 * 1024 ** 2 + 1), page)).toBeUndefined();
});
it('marks EME/custom encryption flags and encrypted HLS as protected', () => {
  expect(parseTencentMedia(body(undefined, { drm: 1 }), page)?.protected).toBe(true);
  expect(parseTencentMedia(body(undefined, { enc: '1' }), page)?.protected).toBe(true);
  expect(
    parseTencentMedia(
      body(
        '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://ltscsy.qq.com/key"\n#EXTINF:5,\na.ts',
      ),
      page,
    )?.protected,
  ).toBe(true);
});
it('rejects playlists escaping to non-Tencent or local URLs and unrelated metadata endpoints', () => {
  expect(
    parseTencentMedia(body('#EXTM3U\n#EXTINF:5,\nhttps://127.0.0.1/a.ts'), page),
  ).toBeUndefined();
  expect(
    parseTencentMedia(
      body('#EXTM3U\n#EXT-X-MAP:URI="https://evil.com/init"\n#EXTINF:5,\na.ts'),
      page,
    ),
  ).toBeUndefined();
  expect(tencentInfoEndpoint('https://vd6.l.qq.com/proxyhttp')).toBe(true);
  expect(tencentInfoEndpoint('https://vd6.l.qq.com.evil.com/proxyhttp')).toBe(false);
  expect(tencentInfoEndpoint('https://vd6.l.qq.com/login')).toBe(false);
});
