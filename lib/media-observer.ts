import { mediaKind, type ObservedMedia } from './discovery';
import {
  inspectPlayerMain,
  mediaIdentity,
  normalizeAudioRequest,
  observedAudio,
  youtubeDirectTrackId,
} from './adapters';
import { candidatePageId } from './media-identity';
import { encode64, decode64 } from './audio';
import { messageError, type AudioSource, type PlaybackSession } from './types';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import type { ObservationScope } from './observation-scope';
/** How long discovered media URLs and their request headers stay usable. */
export const OBSERVATION_TTL_MS = 60000;
export type SourceRecord = { identity: string; source: AudioSource; expiresAt?: number };
export type DiscoveryRecord = { identity: string; items: ObservedMedia[]; expiresAt?: number };
export function registerMediaObserver({
  scope,
  sources,
  detected,
  captureStats,
  getSession,
  stop,
}: {
  scope: ObservationScope;
  sources: Map<number, SourceRecord>;
  detected: Map<number, DiscoveryRecord>;
  captureStats: { responses: number; accepted: number; lastError: string };
  getSession: () => PlaybackSession | null;
  stop: () => Promise<void>;
}) {
  const requests = new Map<string, Record<string, string>>();
  let responseSequence = 0;
  const nativeSequence = new Map<number, number>();
  const bodies = new Map<string, string>();
  const scopes = new Map<string, { revision: number; page: Promise<string | undefined> }>();
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (
        !scope.allows(details.tabId, getSession()?.candidate.tabId) ||
        details.initiator?.startsWith('chrome-extension:')
      )
        return undefined;
      scopes.set(details.requestId, {
        revision: scope.revision(details.tabId),
        page: chrome.tabs
          .get(details.tabId)
          .then((tab) => {
            const url = tab.pendingUrl ?? tab.url;
            return url ? mediaIdentity(url) : undefined;
          })
          .catch(() => undefined),
      });
      if (scopes.size > 500) scopes.delete(scopes.keys().next().value!);
      if (details.method !== 'POST' || !new URL(details.url).hostname.endsWith('.googlevideo.com'))
        return undefined;
      const raw = details.requestBody?.raw;
      if (!raw?.length) return undefined;
      const length = raw.reduce((n, r) => n + (r.bytes?.byteLength ?? 0), 0);
      if (length === 0 || length > 98304) return undefined;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of raw)
        if (part.bytes) {
          bytes.set(new Uint8Array(part.bytes), offset);
          offset += part.bytes.byteLength;
        }
      bodies.set(details.requestId, encode64(bytes));
      if (bodies.size > 30) bodies.delete(bodies.keys().next().value!);
      return undefined;
    },
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['media', 'xmlhttprequest', 'other'],
    },
    ['requestBody'],
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (
        !scope.allows(details.tabId, getSession()?.candidate.tabId) ||
        details.initiator?.startsWith('chrome-extension:')
      )
        return undefined;
      const headers: Record<string, string> = {};
      for (const h of details.requestHeaders ?? [])
        if (['origin', 'referer'].includes(h.name.toLowerCase()) && h.value)
          headers[h.name] = h.value;
      requests.set(details.requestId, headers);
      if (requests.size > 200) requests.delete(requests.keys().next().value!);
      return undefined;
    },
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['media', 'xmlhttprequest', 'other'],
    },
    ['requestHeaders', 'extraHeaders'],
  );
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      if (!scope.allows(details.tabId, getSession()?.candidate.tabId)) {
        scopes.delete(details.requestId);
        bodies.delete(details.requestId);
        requests.delete(details.requestId);
        return;
      }
      captureStats.responses++;
      const headers = requests.get(details.requestId) ?? {};
      requests.delete(details.requestId);
      const sabrRequest = bodies.get(details.requestId);
      bodies.delete(details.requestId);
      const requestScope = scopes.get(details.requestId);
      scopes.delete(details.requestId);
      const mime =
        details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
      const sabr = !!sabrRequest && mime.includes('yt-ump');
      if (
        !scope.allows(details.tabId, getSession()?.candidate.tabId) ||
        details.initiator?.startsWith('chrome-extension:') ||
        details.statusCode < 200 ||
        details.statusCode >= 300 ||
        (!sabr && !observedAudio(details.url, mime) && !mediaKind(details.url, mime))
      )
        return;
      captureStats.accepted++;
      const sequence = ++responseSequence;
      void chrome.tabs
        .get(details.tabId)
        .then(async (tab) => {
          if (!tab.url || !scope.allows(details.tabId, getSession()?.candidate.tabId)) return;
          const identity = mediaIdentity(tab.url);
          if ((await requestScope?.page) !== identity) return;
          const current = () =>
            !!requestScope &&
            scope.allows(details.tabId, getSession()?.candidate.tabId) &&
            scope.revision(details.tabId) === requestScope.revision;
          if (!current()) return;
          const host = new URL(tab.url).hostname;
          if (!/(^|\.)(youtube\.com|bilibili\.com)$/.test(host)) {
            const kind = mediaKind(details.url, mime);
            if (!kind) return;
            const persisted =
              detected.get(details.tabId) ??
              ((await chrome.storage.session.get(`detected:${details.tabId}`))[
                `detected:${details.tabId}`
              ] as DiscoveryRecord | undefined);
            const previous = detected.get(details.tabId) ?? persisted;
            const items =
              previous?.identity === identity && (previous.expiresAt ?? 0) > Date.now()
                ? previous.items.filter((item) => item.at > Date.now() - OBSERVATION_TTL_MS)
                : [];
            const updated = [
              ...items.filter((r) => !(r.url === details.url && r.frameId === details.frameId)),
              {
                url: details.url,
                mime,
                kind,
                frameId: details.frameId,
                at: Date.now(),
                headers,
              },
            ];
            const state = {
              identity,
              expiresAt: Date.now() + OBSERVATION_TTL_MS,
              items: (['file', 'hls', 'dash', 'fragment'] as const).flatMap((k) =>
                updated.filter((r) => r.kind === k).slice(-10),
              ),
            };
            if (!current()) return;
            if (
              detected.get(details.tabId)?.identity &&
              detected.get(details.tabId)?.identity !== identity
            )
              return;
            detected.set(details.tabId, state);
            await chrome.storage.session.set({
              [`detected:${details.tabId}`]: state,
            });
            if (!current()) {
              if (!detected.has(details.tabId) || detected.get(details.tabId) === state) {
                detected.delete(details.tabId);
                await chrome.storage.session.remove(`detected:${details.tabId}`);
              }
              return;
            }
            void chrome.runtime
              .sendMessage({ type: 'sources:updated', tabId: details.tabId })
              .catch(() => {});
            return;
          }
          // Native sites may request video-only files after audio. Generic
          // discovery must never overwrite a native audio source with those.
          if (!sabr && !observedAudio(details.url, mime)) return;
          if (sequence < (nativeSequence.get(details.tabId) ?? 0)) return;
          let trackId = sabr
            ? VideoPlaybackAbrRequest.decode(decode64(sabrRequest!)).clientAbrState?.audioTrackId ||
              'default'
            : 'default';
          if (!sabr && /(?:^|\.)youtube\.com$/.test(host)) {
            const metadata = (
              await chrome.scripting.executeScript({
                target: { tabId: details.tabId },
                world: 'MAIN',
                func: inspectPlayerMain,
              })
            )[0]?.result;
            if (!current() || metadata?.identity !== identity) return;
            const resolved = youtubeDirectTrackId(details.url, metadata);
            if (!resolved) return;
            trackId = resolved;
          }
          if (!current() || sequence < (nativeSequence.get(details.tabId) ?? 0)) return;
          nativeSequence.set(details.tabId, sequence);
          const session = getSession();
          if (
            session?.candidate.tabId === details.tabId &&
            candidatePageId(session.candidate) === identity &&
            (session.candidate.source?.trackId ?? 'default') !== trackId
          ) {
            await stop();
          }
          const saved = {
            identity,
            expiresAt: Date.now() + OBSERVATION_TTL_MS,
            source: {
              url: sabr ? details.url : normalizeAudioRequest(details.url),
              mime,
              headers,
              identity,
              trackId,
              ...(sabr ? { sabrRequest } : {}),
            },
          };
          if (!current() || nativeSequence.get(details.tabId) !== sequence) return;
          sources.set(details.tabId, saved);
          await chrome.storage.session.set({
            [`source:${details.tabId}`]: saved,
          });
          if (!current()) {
            if (!sources.has(details.tabId) || sources.get(details.tabId) === saved) {
              sources.delete(details.tabId);
              await chrome.storage.session.remove(`source:${details.tabId}`);
            }
            return;
          }
          void chrome.runtime
            .sendMessage({ type: 'sources:updated', tabId: details.tabId })
            .catch(() => {});
        })
        .catch((error) => {
          captureStats.lastError = messageError(error);
        });
    },
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['media', 'xmlhttprequest', 'other'],
    },
    ['responseHeaders'],
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      scopes.delete(details.requestId);
      bodies.delete(details.requestId);
      requests.delete(details.requestId);
    },
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['media', 'xmlhttprequest', 'other'],
    },
  );
}
