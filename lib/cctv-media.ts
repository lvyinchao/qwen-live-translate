export interface CctvMedia {
  guid: string;
  url: string;
  duration: number;
  title: string;
}

const MAX_INFO_BYTES = 1024 * 1024;
const GUID = /^[a-f0-9]{32}$/i;
const CDN_SUFFIXES = ['cntv.cn', 'cctv.com', 'cctv.cn', 'cctvpic.com', 'qcloudcdn.com'];
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const clearFlag = (value: unknown) => value === '0' || value === 0 || value === false;

/** Only public desktop VOD pages may query the fixed CCTV metadata endpoint. */
export function cctvInfoEndpoint(pageUrl: string, guid: string): string | undefined {
  if (!GUID.test(guid)) return;
  try {
    const page = new URL(pageUrl);
    if (
      page.protocol !== 'https:' ||
      page.username ||
      page.password ||
      page.port ||
      !/^tv\.cctv\.(?:cn|com)$/.test(page.hostname) ||
      !/^\/\d{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/VIDE[A-Za-z0-9]{12,64}\.shtml$/.test(
        page.pathname,
      )
    )
      return;
    return `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=${guid.toLowerCase()}`;
  } catch {
    return;
  }
}

function publicPlaylist(value: unknown, guid: string): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !CDN_SUFFIXES.some(
        (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
      ) ||
      !url.pathname.toLowerCase().endsWith('.m3u8') ||
      url.hash
    )
      return;
    const segments = decodeURIComponent(url.pathname).split('/');
    if (
      !segments.some((segment) => segment.toLowerCase() === guid) ||
      segments.some((segment) => /^(?:enc\d*|h5e|drm)$/i.test(segment))
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

/** The API has no top-level content GUID: bind its public playlist path to the
 * requested GUID, never to the unrelated chapter GUIDs in `segments`. */
export function parseCctvMedia(text: string, requestedGuid: string): CctvMedia | undefined {
  if (
    !GUID.test(requestedGuid) ||
    typeof text !== 'string' ||
    text.length > MAX_INFO_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_INFO_BYTES
  )
    return;
  try {
    const data = object(JSON.parse(text));
    if (
      !data ||
      data.ack !== 'yes' ||
      data.status !== '001' ||
      !clearFlag(data.is_protected) ||
      !clearFlag(data.is_invalid_copyright) ||
      !clearFlag(data.is_preview) ||
      !['1', 1, true].includes(data.play as string | number | boolean)
    )
      return;
    if (
      (data.public !== undefined &&
        !['1', 1, true].includes(data.public as string | number | boolean)) ||
      (data.asp_error_code !== undefined && !clearFlag(data.asp_error_code))
    )
      return;
    for (const flag of ['drm', 'is_drm', 'protected', 'isProtected', 'encrypted', 'is_encrypted'])
      if (data[flag] !== undefined && !clearFlag(data[flag])) return;
    const video = object(data.video);
    const length = video?.totalLength;
    if (typeof length !== 'number' && (typeof length !== 'string' || !length.trim())) return;
    const duration = Number(length);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      typeof data.title !== 'string' ||
      !data.title.trim() ||
      data.title.length > 4096
    )
      return;
    const guid = requestedGuid.toLowerCase();
    const manifest = object(data.manifest);
    const url = publicPlaylist(manifest?.hls_audio_url, guid) ?? publicPlaylist(data.hls_url, guid);
    if (!url) return;
    return { guid, url, duration, title: data.title.trim() };
  } catch {
    return;
  }
}

/** Fetch only bounded metadata. No credentials, redirects or raw-response logs. */
export async function fetchCctvMedia(
  pageUrl: string,
  guid: string,
): Promise<CctvMedia | undefined> {
  const endpoint = cctvInfoEndpoint(pageUrl, guid);
  if (!endpoint) return;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(endpoint, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const length = response.headers.get('Content-Length');
    if (!response.ok || (length !== null && Number(length) > MAX_INFO_BYTES)) {
      await response.body?.cancel();
      return;
    }
    if (!response.body) return;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_INFO_BYTES) {
        await reader.cancel();
        return;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseCctvMedia(new TextDecoder('utf-8', { fatal: true }).decode(bytes), guid);
  } catch {
    return;
  } finally {
    reader?.releaseLock();
  }
}
