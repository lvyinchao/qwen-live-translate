import { safeMediaUrl } from './security';
import type { AudioSource, Site } from './types';

export function mediaIdentity(url: string): string {
  const u = new URL(url);
  if (u.hostname.endsWith('youtube.com'))
    return `youtube:${u.searchParams.get('v') ?? u.pathname}:${u.searchParams.get('list') ?? ''}`;
  if (u.hostname.endsWith('bilibili.com'))
    return `bilibili:${u.pathname}:${u.searchParams.get('p') ?? '1'}`;
  return `${u.origin}${u.pathname}${u.search}`;
}
export function observedAudio(url: string, mime: string): boolean {
  try {
    const u = new URL(url);
    if (!safeMediaUrl(url)) return false;
    if (mime.toLowerCase().startsWith('audio/')) return true;
    if (u.hostname.endsWith('googlevideo.com'))
      return (
        u.searchParams.get('mime')?.startsWith('audio/') === true ||
        [
          '139',
          '140',
          '141',
          '249',
          '250',
          '251',
          '599',
          '600',
          '18',
          '22',
          '37',
          '38',
          '43',
          '44',
          '45',
          '46',
        ].includes(u.searchParams.get('itag') ?? '')
      );
    if (/(?:bilivideo\.(?:com|cn)|akamaized\.net)$/.test(u.hostname))
      return /(?:^|[-/])(30216|30232|30280|30250|30251)(?:[.\/-]|$)/.test(
        u.pathname,
      );
    return false;
  } catch {
    return false;
  }
}
export function normalizeAudioRequest(url: string): string {
  const u = new URL(url);
  // Googlevideo's range/rn/rbuf describe individual player reads. Preserve all
  // authentication parameters; use an ordinary Range header for later reads.
  if (u.hostname.endsWith('googlevideo.com'))
    for (const key of ['range', 'rn', 'rbuf']) u.searchParams.delete(key);
  return u.href;
}
export interface PlayerMetadata {
  identity: string;
  site: Site;
  source?: AudioSource;
  sabrFormats?: AudioSource['sabrFormats'];
  ad: boolean;
  title: string;
}

// This function is serialized by chrome.scripting into MAIN. It must not close
// over extension data. In particular, credentials are never passed here.
export function inspectPlayerMain(): PlayerMetadata {
  const win = window as any;
  const u = new URL(location.href);
  const title = document.title;
  if (u.hostname.endsWith('youtube.com')) {
    const id = u.searchParams.get('v') ?? u.pathname;
    const player = document.querySelector('#movie_player') as any;
    let response: any;
    try {
      response = player?.getPlayerResponse?.() ?? win.ytInitialPlayerResponse;
    } catch {
      response = win.ytInitialPlayerResponse;
    }
    const identity = `youtube:${id}:${u.searchParams.get('list') ?? ''}`;
    const valid = response?.videoDetails?.videoId === id;
    const tracks = valid
      ? (response?.streamingData?.adaptiveFormats ?? [])
      : [];
    const track = tracks
      .filter(
        (t: any) =>
          typeof t.url === 'string' && t.mimeType?.startsWith('audio/'),
      )
      .sort(
        (a: any, b: any) => (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity),
      )[0];
    const sabrFormats = tracks
      .filter((t: any) => t.mimeType?.startsWith('audio/') && t.lastModified)
      .map((t: any) => ({
        itag: t.itag,
        lastModified: t.lastModified,
        xtags: t.xtags,
        audioTrackId: t.audioTrack?.id,
        isDefault: t.audioTrack?.audioIsDefault,
        isDrc: t.isDrc,
        mimeType: t.mimeType,
        bitrate: t.bitrate,
        audioChannels: t.audioChannels,
        audioQuality: t.audioQuality,
        approxDurationMs: t.approxDurationMs,
      }));
    return {
      identity,
      site: 'youtube',
      sabrFormats,
      title: response?.videoDetails?.title ?? title,
      ad: Boolean(player?.classList?.contains('ad-showing')),
      source: track
        ? { url: track.url, mime: track.mimeType, identity }
        : undefined,
    };
  }
  if (u.hostname.endsWith('bilibili.com')) {
    const data = win.__playinfo__?.data ?? win.__playinfo__?.result;
    const identity = `bilibili:${u.pathname}:${u.searchParams.get('p') ?? '1'}`;
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const original = navigation ? new URL(navigation.name) : undefined;
    const sameNavigation =
      original?.pathname === u.pathname &&
      (original?.searchParams.get('p') ?? '1') ===
        (u.searchParams.get('p') ?? '1');
    const tracks = sameNavigation ? (data?.dash?.audio ?? []) : [];
    const track = tracks
      .filter((t: any) => typeof (t.baseUrl ?? t.base_url) === 'string')
      .sort(
        (a: any, b: any) =>
          (a.bandwidth ?? Infinity) - (b.bandwidth ?? Infinity),
      )[0];
    return {
      identity,
      site: 'bilibili',
      title,
      ad: Boolean(
        document.querySelector('.bpx-player-video-ad[data-show="true"]'),
      ),
      source: track
        ? {
            url: track.baseUrl ?? track.base_url,
            mime: track.mimeType ?? track.mime_type,
            identity,
          }
        : undefined,
    };
  }
  return {
    identity: `${u.origin}${u.pathname}${u.search}`,
    site: 'generic',
    title,
    ad: false,
  };
}
