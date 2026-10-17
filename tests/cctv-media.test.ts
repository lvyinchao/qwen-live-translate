import { afterEach, describe, expect, it, vi } from 'vitest';
import { cctvInfoEndpoint, fetchCctvMedia, parseCctvMedia } from '../lib/cctv-media';

const guid = '1234567890abcdef1234567890abcdef';
const page = 'https://tv.cctv.cn/2026/10/10/VIDEabcdefghijklmnopqrstuv261010.shtml';
const full = `https://vod.qcloudcdn.com/asp/hls/main/series/${guid}/main.m3u8?maxbr=2048`;
const audio = `https://audio.v.cntv.cn/asp/hlsaudio/hls/main/series/${guid}/main.m3u8`;
const fixture = (changes: Record<string, unknown> = {}) => ({
  ack: 'yes',
  status: '001',
  is_protected: '0',
  is_invalid_copyright: '0',
  is_preview: '0',
  play: '1',
  title: 'Synthetic CCTV programme',
  video: { totalLength: '2678.68' },
  hls_url: full,
  manifest: { hls_audio_url: audio },
  ...changes,
});
const parse = (changes: Record<string, unknown> = {}) =>
  parseCctvMedia(JSON.stringify(fixture(changes)), guid);
afterEach(() => vi.unstubAllGlobals());

describe('fixed CCTV metadata endpoint', () => {
  it('accepts the two desktop VOD domains and normalizes only the content GUID', () => {
    const endpoint = `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=${guid}`;
    expect(cctvInfoEndpoint(page, guid.toUpperCase())).toBe(endpoint);
    expect(cctvInfoEndpoint(page.replace('cctv.cn', 'cctv.com') + '?from=fixture', guid)).toBe(
      endpoint,
    );
  });
  it('does not turn arbitrary sites, paths, credentials or a malformed GUID into requests', () => {
    for (const invalid of [
      page.replace('https:', 'http:'),
      page.replace('tv.cctv.cn', 'localhost'),
      page.replace('tv.cctv.cn', 'tv.cctv.cn.example.com'),
      page.replace('tv.cctv.cn', 'news.cctv.cn'),
      page.replace('/2026/10/10/', '/live/'),
      page.replace('https://', 'https://user:password@'),
      page.replace('tv.cctv.cn', 'tv.cctv.cn:444'),
      'https://tv.cctv.cn/live/',
      'not a URL',
    ])
      expect(cctvInfoEndpoint(invalid, guid), invalid).toBeUndefined();
    for (const id of ['', 'a'.repeat(31), 'g'.repeat(32), guid + '&other=1'])
      expect(cctvInfoEndpoint(page, id)).toBeUndefined();
  });
});

describe('public playlist validation', () => {
  it('prefers API-provided audio-only HLS and binds its exact GUID, title and duration', () => {
    expect(parse()).toEqual({
      guid,
      url: audio,
      duration: 2678.68,
      title: 'Synthetic CCTV programme',
    });
    expect(parse({ manifest: undefined })?.url).toBe(full);
    expect(parse({ manifest: { hls_audio_url: 'https://foreign.example/main.m3u8' } })?.url).toBe(
      full,
    );
    expect(parse({ manifest: undefined, video: { totalLength: 30 } })?.duration).toBe(30);
  });
  it('rejects unsuccessful, protected, preview, copyright-restricted or disabled playback', () => {
    for (const changes of [
      { ack: 'no' },
      { status: '002' },
      { status: undefined },
      { is_protected: '1' },
      { is_protected: undefined },
      { is_invalid_copyright: 1 },
      { is_preview: true },
      { play: '0' },
      { play: undefined },
      { drm: 'widevine' },
      { is_drm: true },
      { encrypted: '1' },
      { public: '0' },
      { asp_error_code: '1' },
    ])
      expect(parse(changes), JSON.stringify(changes)).toBeUndefined();
  });
  it('rejects foreign, local, cleartext, credentialed, encrypted or wrong-content playlist URLs', () => {
    const urls = [
      full.replace('vod.qcloudcdn.com', '127.0.0.1'),
      full.replace('vod.qcloudcdn.com', 'localhost'),
      full.replace('vod.qcloudcdn.com', 'qcloudcdn.com.example.org'),
      full.replace('https:', 'http:'),
      full.replace('https://', 'https://user:password@'),
      full.replace(guid, 'f'.repeat(32)),
      full.replace(guid, 'prefix' + guid),
      full.replace('.m3u8', '.ts'),
      full.replace('/asp/hls/', '/asp/enc/hls/'),
      full.replace('/asp/hls/', '/asp/enc2/hls/'),
      full.replace('/asp/hls/', '/asp/h5e/hls/'),
      full.replace('/asp/hls/', '/asp/%65nc/hls/'),
      full.replace('vod.qcloudcdn.com', 'vod.qcloudcdn.com:444'),
    ];
    for (const url of urls)
      expect(parse({ hls_url: url, manifest: { hls_audio_url: url } }), url).toBeUndefined();
    expect(
      parse({ hls_url: undefined, manifest: { hls_enc_url: full, hls_h5e_url: full } }),
    ).toBeUndefined();
    // Programme chapters identify different clips and cannot authorize this URL.
    expect(
      parse({ hls_url: full.replace(guid, 'f'.repeat(32)), manifest: {}, segments: [{ guid }] }),
    ).toBeUndefined();
  });
  it('rejects malformed/bounded JSON, invalid durations and missing programme titles', () => {
    for (const text of [
      'not JSON',
      '[]',
      'null',
      ' '.repeat(1024 * 1024 + 1),
      JSON.stringify({ title: '中'.repeat(400000) }),
    ])
      expect(parseCctvMedia(text, guid)).toBeUndefined();
    for (const value of [0, -1, null, '', 'Infinity', 'NaN', {}, []])
      expect(parse({ video: { totalLength: value } })).toBeUndefined();
    expect(parse({ title: '  ' })).toBeUndefined();
    expect(parseCctvMedia(JSON.stringify(fixture()), 'f'.repeat(32))).toBeUndefined();
  });
});

describe('bounded metadata fetching', () => {
  it('uses the fixed endpoint, no credentials/redirects/cache, and an abort signal', async () => {
    const body = JSON.stringify(fixture());
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchCctvMedia(page, guid)).toEqual(parse());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(cctvInfoEndpoint(page, guid));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
  });
  it('never fetches unsupported pages and returns no media on HTTP, parse or network failure', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchCctvMedia('https://example.com/', guid)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect(await fetchCctvMedia(page, guid)).toBeUndefined();
    fetcher.mockResolvedValueOnce(new Response('invalid JSON'));
    expect(await fetchCctvMedia(page, guid)).toBeUndefined();
    fetcher.mockRejectedValueOnce(new Error('offline fixture'));
    expect(await fetchCctvMedia(page, guid)).toBeUndefined();
  });
  it('cancels oversized streamed and declared bodies without reading an unbounded response', async () => {
    const cancelled = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(600000));
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(stream));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchCctvMedia(page, guid)).toBeUndefined();
    expect(pulls).toBe(2);
    expect(cancelled).toHaveBeenCalledOnce();
    const declaredCancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: declaredCancel }), {
        headers: { 'Content-Length': String(1024 * 1024 + 1) },
      }),
    );
    expect(await fetchCctvMedia(page, guid)).toBeUndefined();
    expect(declaredCancel).toHaveBeenCalledOnce();
  });
});
