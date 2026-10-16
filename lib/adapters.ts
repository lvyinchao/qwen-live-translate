import { safeMediaUrl } from './security';
import { canonicalMediaResource } from './media-identity';
import type { AudioSource, Site } from './types';

export function mediaIdentity(url: string): string {
  const u = new URL(url);
  if (/(?:^|\.)youtube\.com$/.test(u.hostname))
    return `youtube:${u.searchParams.get('v') ?? u.pathname}:${u.searchParams.get('list') ?? ''}`;
  if (/(?:^|\.)bilibili\.com$/.test(u.hostname))
    return `bilibili:${u.pathname}:${u.searchParams.get('p') ?? '1'}`;
  return `${u.origin}${u.pathname}${u.search}${u.hash}`;
}
export function observedAudio(url: string, mime: string): boolean {
  try {
    const u = new URL(url);
    if (!safeMediaUrl(url)) return false;
    if (mime.toLowerCase().startsWith('audio/')) return true;
    if (/(?:^|\.)googlevideo\.com$/.test(u.hostname))
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
  if (/(?:^|\.)googlevideo\.com$/.test(u.hostname))
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
  /** Only set when the native player explicitly identifies its selected track. */
  currentAudioTrackId?: string;
  /** Direct URLs verified to belong to the selected/unambiguous audio group. */
  audioSources?: AudioSource[];
  sourceReason?: string;
}

/** Resolve direct reads against current native metadata, never guess from bitrate/language. */
export function youtubeDirectTrackId(url: string, metadata: PlayerMetadata): string | undefined {
  if (metadata.site !== 'youtube') return;
  const request = new URL(url);
  const explicit = ['audio_track_id', 'audioTrackId', 'trackId', 'track']
    .map((key) => request.searchParams.get(key)).find(Boolean);
  if (explicit && metadata.currentAudioTrackId)
    return explicit === metadata.currentAudioTrackId ? explicit : undefined;
  const resource = canonicalMediaResource(normalizeAudioRequest(url));
  return metadata.audioSources?.find((source) =>
    canonicalMediaResource(normalizeAudioRequest(source.url)) === resource)?.trackId;
}

/** Discard legacy/default direct sources and sources from a formerly selected track. */
export function youtubeSourceMatches(source: AudioSource, metadata: PlayerMetadata): boolean {
  if (metadata.site !== 'youtube') return true;
  if (metadata.currentAudioTrackId)
    return source.trackId === metadata.currentAudioTrackId;
  if (source.sabrRequest) return true;
  return !!source.trackId && metadata.audioSources?.some((item) => item.trackId === source.trackId) === true;
}

// This function is serialized by chrome.scripting into MAIN. It must not close
// over extension data. In particular, credentials are never passed here.
export async function inspectPlayerMain(): Promise<PlayerMetadata> {
  const win = window as any;
  const u = new URL(location.href);
  const title = document.title;
  if (/(?:^|\.)youtube\.com$/.test(u.hostname)) {
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
    const direct = tracks.filter((t: any) => typeof t.url === 'string' && t.mimeType?.startsWith('audio/'));
    let currentAudioTrackId: string | undefined;
    try {
      const selected = player?.getAudioTrack?.();
      const id = typeof selected === 'string' ? selected : selected?.id;
      if (typeof id === 'string' && id.length > 0 && id.length <= 256)
        currentAudioTrackId = id;
    } catch { /* Undocumented native APIs can be absent on some player variants. */ }
    const audioId = (track: any): string | undefined => {
      const id = track.audioTrack?.id;
      if (typeof id === 'string' && id.length > 0 && id.length <= 256) return id;
      try {
        const url = new URL(track.url);
        const id = ['audio_track_id', 'audioTrackId', 'trackId', 'track']
          .map((key) => url.searchParams.get(key)).find(Boolean);
        return id && id.length <= 256 ? id : undefined;
      } catch { return; }
    };
    const known = new Set(direct.map(audioId).filter(Boolean));
    let selected = currentAudioTrackId
      ? direct.filter((track: any) => audioId(track) === currentAudioTrackId)
      : known.size === 1 && direct.every((track: any) => audioId(track)) ? direct : [];
    const audioSources: AudioSource[] = selected.map((track: any) => ({
      url: track.url, mime: track.mimeType, identity, trackId: audioId(track),
    }));
    // An anonymous single URL is usable, but it must not share the old `default`
    // cache namespace with another asset/voice. Multiple anonymous variants are
    // ambiguous: codec/bitrate alone cannot prove that their language is equal.
    if (!currentAudioTrackId && direct.length === 1 && !audioId(direct[0])) {
      const resource = new URL(direct[0].url);
      resource.hash = '';
      for (const key of [...resource.searchParams.keys()])
        if (/^(?:range|rn|rbuf|expires?|deadline|signature|sign|sig|wssecret|wstime|auth_key|authkey)$/i.test(key))
          resource.searchParams.delete(key);
      resource.searchParams.sort();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resource.href));
      const trackId = `yt-direct:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      selected = direct;
      audioSources.push({ url: direct[0].url, mime: direct[0].mimeType, identity, trackId });
    }
    const track = selected.sort((a: any, b: any) => (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity))[0];
    const source = track ? audioSources.find((item) => item.url === track.url) : undefined;
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
      currentAudioTrackId,
      audioSources,
      sourceReason: !source && direct.length
        ? '播放器未提供可确认当前音轨归属的信息，请先播放几秒或重新选择音轨后扫描'
        : undefined,
      ad: Boolean(player?.classList?.contains('ad-showing')),
      source,
    };
  }
  if (/(?:^|\.)bilibili\.com$/.test(u.hostname)) {
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
    identity: `${u.origin}${u.pathname}${u.search}${u.hash}`,
    site: /(^|\.)youku\.com$/.test(u.hostname)
      ? 'youku'
      : /(^|\.)iqiyi\.com$/.test(u.hostname)
        ? 'iqiyi'
        : /(^|\.)qq\.com$/.test(u.hostname)
          ? 'tencent'
          : 'generic',
    title,
    ad: false,
  };
}
