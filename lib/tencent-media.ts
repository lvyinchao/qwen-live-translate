import { safeMediaUrl } from './security';
export interface TencentMediaInfo {
  videoId: string;
  url: string;
  playlist: string;
  protected: boolean;
  playerId?: string;
}
export function tencentInfoEndpoint(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      /^vd\d*\.l\.qq\.com$/.test(u.hostname) &&
      /^\/(?:proxyhttp|vinfo_proxy)$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
export function tencentCdn(value: string): boolean {
  if (!safeMediaUrl(value, true)) return false;
  const host = new URL(value).hostname;
  return ['qq.com', 'smtcdns.com'].some(
    (d) => host === d || host.endsWith('.' + d),
  );
}
export function parseTencentMedia(
  text: string,
  pageUrl: string,
): TencentMediaInfo | undefined {
  if (text.length > 2 * 1024 ** 2) return;
  try {
    const page = new URL(pageUrl);
    if (page.hostname !== 'v.qq.com') return;
    const videoId = page.pathname.match(/\/([a-zA-Z0-9]+)\.html$/)?.[1];
    if (!videoId) return;
    const response = JSON.parse(text);
    let vinfo = response.vinfo ?? response.data?.vinfo ?? response.data;
    if (typeof vinfo === 'string') vinfo = JSON.parse(vinfo);
    const vi = vinfo?.vl?.vi?.find((v: { vid?: string }) => v.vid === videoId);
    if (!vi) return;
    const playlist = vi.ul?.m3u8;
    const url = vi.ul?.ui
      ?.map((u: { url?: string }) => u.url)
      .find((s: unknown) => typeof s === 'string' && tencentCdn(s));
    if (
      !url ||
      typeof playlist !== 'string' ||
      playlist.length > 256 * 1024 ||
      !playlist.trimStart().startsWith('#EXTM3U')
    )
      return;
    const protectedMedia =
      Number(vi.drm ?? 0) !== 0 ||
      Number(vi.enc ?? 0) !== 0 ||
      playlist
        .split(/\r?\n/)
        .some(
          (line) =>
            line.startsWith('#EXT-X-KEY:') &&
            !/^#EXT-X-KEY:METHOD=NONE(?:,|$)/.test(line),
        );
    for (const line of playlist.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      if (!tencentCdn(new URL(line.trim(), url).href)) return;
    }
    for (const match of playlist.matchAll(/URI="([^"]+)"/g))
      if (!tencentCdn(new URL(match[1]!, url).href)) return;
    return { videoId, url, playlist, protected: protectedMedia };
  } catch {
    return;
  }
}
