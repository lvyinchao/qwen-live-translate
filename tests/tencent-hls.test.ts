import { afterEach, expect, it, vi } from 'vitest';
import { observeTencentHls } from '../lib/tencent-hls';

type Listener = (...args: unknown[]) => void;
import type { TencentMediaInfo } from '../lib/tencent-media';
const url = 'https://ltscsy.qq.com/video/index.m3u8';
const playlist = '#EXTM3U\n#EXTINF:30,\nsegment.ts\n#EXT-X-ENDLIST';
function setup() {
  const win: any = {};
  const loc = { href: 'https://v.qq.com/x/cover/cid/episode1.html' };
  class Video {
    dataset: Record<string, string> = {};
    mediaKeys: object | null = null;
  }
  class Hls {
    media = new Video();
    config: any = {};
    currentLevel = 0;
    handlers = new Map<string, Set<Listener>>();
    received: unknown[] = [];
    loadSource(...args: unknown[]) {
      this.received = args;
      return 'native-result';
    }
    on(event: string, fn: Listener) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(fn);
    }
    off(event: string, fn: Listener) {
      this.handlers.get(event)?.delete(fn);
    }
    emit(event: string, data: unknown) {
      for (const fn of this.handlers.get(event) ?? []) fn(event, data);
    }
  }
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', loc);
  vi.stubGlobal('HTMLVideoElement', Video);
  const seen: TencentMediaInfo[] = [];
  observeTencentHls((info) => seen.push(info));
  win.ThumbPlayerKernelHlsjs = { Hls };
  return { hls: new Hls(), loc, seen };
}
afterEach(() => vi.unstubAllGlobals());
it('observes delayed native HLS metadata and ties it to the exact video without changing the native call', () => {
  const { hls, seen } = setup();
  expect(hls.loadSource(url)).toBe('native-result');
  expect(hls.received).toEqual([url]);
  hls.emit('hlsLevelLoaded', { details: { url, m3u8: playlist, live: false } });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    videoId: 'episode1',
    playerId: hls.media.dataset.qvdId,
    playlist,
    protected: false,
  });
  hls.loadSource(url);
  hls.emit('hlsLevelLoaded', { details: { url, m3u8: playlist, live: false } });
  expect(seen).toHaveLength(2);
});
it('ignores live, unsafe and stale episode metadata; keeps protected sources protected', () => {
  const { hls, loc, seen } = setup();
  hls.loadSource(url);
  hls.emit('hlsLevelLoaded', { details: { url, m3u8: playlist, live: true } });
  hls.emit('hlsLevelLoaded', {
    details: { url: 'https://127.0.0.1/x', m3u8: playlist, live: false },
  });
  loc.href = loc.href.replace('episode1', 'episode2');
  hls.emit('hlsLevelLoaded', { details: { url, m3u8: playlist, live: false } });
  expect(seen).toHaveLength(0);
  hls.media.mediaKeys = {};
  hls.loadSource(url, playlist);
  expect(seen[0]).toMatchObject({ videoId: 'episode2', protected: true });
});
