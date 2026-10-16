import type { AudioSource, MediaCandidate } from './types';

const TRANSIENT = /^(?:expires?|deadline|signature|sign|sig|wssecret|wstime|auth_key|authkey|x-amz-(?:signature|date|expires|credential|security-token)|x-oss-(?:signature|date|expires|credential|security-token))$/i;
/** Retain unknown/content query parameters, including opaque tokens: a cache miss
 * is safer than treating a token-addressed different asset as the same video. */
export function canonicalMediaResource(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (TRANSIENT.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
export async function mediaResourceIdentity(
  pageId: string,
  frameUrl: string,
  source: AudioSource,
): Promise<string> {
  const resource = canonicalMediaResource(source.url);
  // Inline VOD manifests may share a generic API URL. Retain timeline and init
  // tags as well as media paths: equal paths alone do not imply equal timestamps.
  const manifestResources = source.hlsManifest
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.startsWith('#')
      ? line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${canonicalMediaResource(new URL(uri, source.url).href)}"`)
      : canonicalMediaResource(new URL(line, source.url).href));
  const bytes = new TextEncoder().encode(
    JSON.stringify([pageId, frameUrl, resource, source.trackId ?? 'default', manifestResources]),
  );
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `media:v2:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export function candidatePageId(candidate: MediaCandidate): string {
  return candidate.pageId ?? candidate.mediaId;
}
