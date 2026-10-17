import { parseTencentMedia, type TencentMediaInfo } from './tencent-media';

/** The subset of the page's hls.js build that observation touches. */
interface HlsLevelDetails { m3u8?: unknown; url?: unknown; live?: boolean }
interface HlsManifestData { levels?: { details?: HlsLevelDetails }[]; url?: unknown }
interface HlsLevelData { details?: HlsLevelDetails }
type HlsListener = (event: unknown, data: unknown) => void;
interface HlsInstance {
  media?: unknown;
  config?: { chachaParam?: unknown };
  currentLevel?: number;
  on?(event: string, listener: HlsListener): void;
  off?(event: string, listener: HlsListener): void;
  once?(event: string, listener: HlsListener): void;
}
interface HlsPrototype extends HlsInstance {
  loadSource(this: HlsInstance, ...args: unknown[]): unknown;
}
interface HlsModule { Hls?: { prototype?: HlsPrototype } }

/** Observe the native player's clear HLS input; never alter its media or playback. */
export function observeTencentHls(
  publish: (info: TencentMediaInfo) => void,
): void {
  const win = window as Window & { ThumbPlayerKernelHlsjs?: unknown };
  const wrapped = new WeakSet<object>();
  const attach = (exports: unknown) => {
    const prototype = (exports as HlsModule | undefined)?.Hls?.prototype;
    if (
      !prototype ||
      typeof prototype.loadSource !== 'function' ||
      wrapped.has(prototype)
    )
      return;
    wrapped.add(prototype);
    const native = prototype.loadSource;
    const listeners = new WeakMap<
      object,
      { manifest: HlsListener; level: HlsListener }
    >();
    prototype.loadSource = function (this: HlsInstance, ...args: unknown[]) {
      const [url, manifest] = args;
      const pageUrl = location.href;
      const emit = (playlist: unknown = manifest, base: unknown = url) => {
        try {
          const media = this.media;
          if (
            location.href !== pageUrl ||
            !(media instanceof HTMLVideoElement) ||
            typeof base !== 'string' ||
            typeof playlist !== 'string'
          )
            return;
          const videoId = new URL(pageUrl).pathname.match(
            /\/([a-zA-Z0-9]+)\.html$/,
          )?.[1];
          if (!videoId) return;
          const info = parseTencentMedia(
            JSON.stringify({
              vinfo: {
                vl: {
                  vi: [
                    {
                      vid: videoId,
                      drm: media.mediaKeys || this.config?.chachaParam ? 1 : 0,
                      ul: { m3u8: playlist, ui: [{ url: base }] },
                    },
                  ],
                },
              },
            }),
            location.href,
          );
          if (!info) return;
          info.playerId = media.dataset.qvdId ??= crypto.randomUUID();
          publish(info);
        } catch {
          /* Observation must not interrupt the site's player. */
        }
      };
      const previous = listeners.get(this);
      if (previous && typeof this.off === 'function') {
        this.off('hlsManifestLoaded', previous.manifest);
        this.off('hlsLevelLoaded', previous.level);
      }
      const next = {
        manifest: (_event: unknown, payload: unknown) => {
          const data = payload as HlsManifestData | undefined;
          const level = data?.levels?.[Math.max(0, this.currentLevel ?? 0)];
          if (level?.details && !level.details.live)
            emit(level.details.m3u8, level.details.url ?? data?.url);
        },
        level: (_event: unknown, payload: unknown) => {
          const data = payload as HlsLevelData | undefined;
          if (data?.details && !data.details.live)
            emit(data.details.m3u8, data.details.url ?? url);
        },
      };
      if (typeof this.on === 'function') {
        this.on('hlsManifestLoaded', next.manifest);
        this.on('hlsLevelLoaded', next.level);
        listeners.set(this, next);
      }
      const result = Reflect.apply(native, this, args);
      emit();
      if (!this.media && typeof this.once === 'function')
        this.once('hlsMediaAttached', () => emit());
      return result;
    };
  };
  const key = 'ThumbPlayerKernelHlsjs';
  const descriptor = Object.getOwnPropertyDescriptor(win, key);
  if (
    !descriptor ||
    ('value' in descriptor && descriptor.configurable && descriptor.writable)
  ) {
    let value = win.ThumbPlayerKernelHlsjs;
    try {
      attach(value);
    } catch {
      /* Leave unsupported SDK shapes alone. */
    }
    Object.defineProperty(win, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => value,
      set: (next) => {
        value = next;
        try {
          attach(next);
        } catch {
          /* Preserve native assignment. */
        }
      },
    });
  } else
    try {
      attach(win.ThumbPlayerKernelHlsjs);
    } catch {
      /* Preserve native exports. */
    }
}
