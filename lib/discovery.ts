import { safeMediaUrl } from './security';
import type { AudioSource } from './types';
export type MediaKind = 'file' | 'hls' | 'dash' | 'fragment';
export interface ObservedMedia {
  url: string;
  mime: string;
  kind: MediaKind;
  frameId: number;
  at: number;
  headers: Record<string, string>;
  hlsManifest?: string;
  protected?: boolean;
  playerId?: string;
}
export function mediaKind(url: string, mime: string): MediaKind | undefined {
  if (!safeMediaUrl(url, true)) return;
  const path = new URL(url).pathname.toLowerCase();
  const type = mime.toLowerCase().split(';')[0]!.trim();
  if (path.endsWith('.m3u8') || /mpegurl/.test(type)) return 'hls';
  if (path.endsWith('.mpd') || type === 'application/dash+xml') return 'dash';
  if (/\.(m4s|ts|cmfv|cmfa)$/.test(path) || type === 'video/mp2t')
    return 'fragment';
  if (
    /^(audio|video)\//.test(type) ||
    /\.(mp4|m4a|webm|mp3|wav|ogg|oga|flac)$/.test(path)
  )
    return 'file';
}
export function chooseGenericSource(
  video: { id?: string; url: string; frameUrl: string; protected: boolean },
  resources: ObservedMedia[],
  identity: string,
  playersInFrame: number,
): { source?: AudioSource; reason?: string } {
  if (video.protected) return { reason: '检测到受保护视频，暂不支持提前翻译' };
  const direct = mediaKind(video.url, '');
  if (direct === 'dash')
    return { reason: '已发现 DASH 清单，暂未接入该站音轨解析' };
  if (direct === 'fragment')
    return { reason: '已发现媒体分片，尚缺可提前读取的完整音轨' };
  const chosen =
    direct === 'file' || direct === 'hls'
      ? { url: video.url, mime: '', kind: direct, headers: {} }
      : undefined;
  const playable = resources.filter(
    (r) =>
      (!r.playerId || r.playerId === video.id) &&
      (r.kind === 'file' || r.kind === 'hls'),
  );
  const attached = playable.find((r) => r.playerId && r.playerId === video.id);
  const audio = playable.filter((r) => r.mime.startsWith('audio/'));
  const choices = audio.length ? audio : playable;
  if (
    resources.some(
      (r) => r.protected && (!r.playerId || r.playerId === video.id),
    )
  )
    return { reason: '检测到受保护视频，暂不支持提前翻译' };
  const resource =
    chosen ??
    attached ??
    (playersInFrame === 1 &&
    choices.length === 1 &&
    // A short ad MP4 can coexist with the main player's TS/fMP4 segments.
    // Being the only standalone file does not associate it with the player.
    !(
      choices[0]?.kind === 'file' &&
      resources.some((r) => r.kind === 'fragment')
    )
      ? choices[0]
      : undefined);
  if (resource)
    return {
      source: {
        url: resource.url,
        mime: resource.mime,
        kind: resource.kind as 'file' | 'hls',
        identity,
        hlsManifest:
          'hlsManifest' in resource ? resource.hlsManifest : undefined,
        headers: {
          Referer: video.frameUrl,
          Origin: new URL(video.frameUrl).origin,
          ...resource.headers,
        },
      },
    };
  if (choices.length)
    return { reason: '发现多个媒体资源，暂无法确定当前视频音轨' };
  if (resources.some((r) => r.kind === 'dash'))
    return { reason: '已发现 DASH 清单，暂未接入该站音轨解析' };
  if (resources.some((r) => r.kind === 'fragment'))
    return { reason: '已发现媒体分片，尚缺可提前读取的完整音轨' };
  return {};
}
/** Used both in the isolated player and serialized scan; includes open shadow DOM. */
export function pageVideos(): HTMLVideoElement[] {
  const result: HTMLVideoElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    result.push(...root.querySelectorAll('video'));
    for (const element of root.querySelectorAll('*'))
      if (element.shadowRoot) walk(element.shadowRoot);
  };
  walk(document);
  return result;
}
// Serialized by scripting.executeScript: do not capture imported functions.
export function inspectVideos(mainOnly = false) {
  const videos: HTMLVideoElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    videos.push(...root.querySelectorAll('video'));
    for (const element of root.querySelectorAll('*'))
      if (element.shadowRoot) walk(element.shadowRoot);
  };
  if (mainOnly)
    videos.push(
      ...document.querySelectorAll<HTMLVideoElement>('#movie_player video'),
    );
  else walk(document);
  const identityKey = Symbol.for('qvd.video.elementIdentity');
  const assigned = new Set(
    videos
      .map((v) => (v as any)[identityKey] as string | undefined)
      .filter(Boolean),
  );
  const seen = new Set<string>();
  return videos.map((v, index) => {
    // Cloned/replaced media elements can inherit dataset attributes. IDs must
    // identify one element, otherwise a command may bind to an old player.
    const known = (v as any)[identityKey] as string | undefined;
    if (known) v.dataset.qvdId = known;
    else if (
      !v.dataset.qvdId ||
      seen.has(v.dataset.qvdId) ||
      assigned.has(v.dataset.qvdId)
    )
      v.dataset.qvdId = crypto.randomUUID();
    (v as any)[identityKey] = v.dataset.qvdId;
    seen.add(v.dataset.qvdId);
    const box = v.getBoundingClientRect();
    const style = getComputedStyle(v);
    return {
      id: v.dataset.qvdId,
      title: document.title,
      poster: v.poster,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      currentTime: v.currentTime,
      width: v.videoWidth || v.clientWidth,
      height: v.videoHeight || v.clientHeight,
      paused: v.paused,
      playbackRate: v.playbackRate,
      index,
      url: v.currentSrc || v.src || v.querySelector('source')?.src || '',
      frameUrl: location.href,
      protected: Boolean(v.mediaKeys),
      displayed:
        box.width > 0 &&
        box.height > 0 &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        style.display !== 'none' &&
        (v.checkVisibility?.({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }) ??
          true),
      displayWidth: box.width,
      displayHeight: box.height,
      bilibiliMain: Boolean(v.closest('.bpx-player-video-wrap,.bilibili-player-video-wrap')),
      cctvMain: v.id === '_video_player_html5_api' && Boolean(v.closest('#_video')),
      youtubeMain:
        Boolean(v.closest('#movie_player')) &&
        v.classList.contains('html5-main-video'),
    };
  });
}

/** One watch-page player owns all YouTube resolution/codec variants. */
export function youtubePlayer(videos: ReturnType<typeof inspectVideos>) {
  return videos
    .filter((v) => v.displayed && v.youtubeMain)
    .sort(
      (a, b) =>
        Number(a.paused) - Number(b.paused) ||
        b.displayWidth * b.displayHeight - a.displayWidth * a.displayHeight ||
        a.index - b.index,
    )
    .slice(0, 1);
}

/** Only one native Bilibili player may own the page's main audio metadata. */
export function bilibiliPlayer(videos: ReturnType<typeof inspectVideos>) {
  const visible = videos.filter((video) => video.displayed);
  const main = visible.filter((video) => video.bilibiliMain);
  return (main.length ? main : visible).sort((a, b) =>
    b.displayWidth * b.displayHeight - a.displayWidth * a.displayHeight ||
    Number(a.paused) - Number(b.paused) || a.index - b.index).slice(0, 1);
}
