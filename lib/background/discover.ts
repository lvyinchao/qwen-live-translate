import { fetchCctvMedia, type CctvMedia } from '../cctv-media';
import { chooseGenericSource, inspectVideos, youtubePlayer, bilibiliPlayer } from '../discovery';
import { inspectPlayerMain, mediaIdentity, observedAudio, youtubeSourceMatches } from '../adapters';
import { mediaResourceIdentity } from '../media-identity';
import { OBSERVATION_TTL_MS, type DiscoveryRecord, type SourceRecord } from '../media-observer';
import { safeMediaUrl } from '../security';
import type { AudioSource, MediaCandidate } from '../types';
import { isFinished, type BackgroundContext } from './context';
import { stopSession } from './session';

const CCTV_TTL_MS = 5 * 60000;
const CCTV_RETRY_MS = 2000;
const CCTV_IDENTITY_API = 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=';

const inspectFrames = (tabId: number) =>
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    func: inspectVideos,
  });
const inspectMain = (tabId: number) =>
  chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: inspectPlayerMain });

/** Looks up the fixed CCTV API once per page GUID, with a short failure backoff. */
function cctvLookup(
  ctx: BackgroundContext,
  tabId: number,
  identity: string,
  guid: string,
  url: string,
) {
  const stored = ctx.cctvSources.get(tabId);
  if (
    stored &&
    stored.identity === identity &&
    stored.guid === guid &&
    stored.expiresAt > Date.now()
  )
    return stored.value;
  const next = {
    identity,
    guid,
    expiresAt: Date.now() + CCTV_TTL_MS,
    value: fetchCctvMedia(url, guid),
  };
  ctx.cctvSources.set(tabId, next);
  // Briefly back off failed lookups, while allowing the panel's next scan
  // to recover from transient API/network errors instead of caching them.
  void next.value.then((value) => {
    if (!value) next.expiresAt = Date.now() + CCTV_RETRY_MS;
  });
  return next.value;
}

async function storedRecord<T extends SourceRecord | DiscoveryRecord>(
  memory: Map<number, T>,
  prefix: 'source' | 'detected',
  tabId: number,
): Promise<T | undefined> {
  const key = `${prefix}:${tabId}`;
  return memory.get(tabId) ?? ((await chrome.storage.session.get(key))[key] as T | undefined);
}

const countKinds = (items: { kind: string }[]) =>
  [...new Set(items.map((r) => r.kind))].map((kind) => ({
    kind,
    count: items.filter((r) => r.kind === kind).length,
  }));

/** Scans a tab for controllable players and the audio each one can read ahead. */
export async function discover(ctx: BackgroundContext, tabId: number): Promise<MediaCandidate[]> {
  ctx.observation.watch(tabId);
  await ctx.pruneObservations();
  const revision = ctx.observation.revision(tabId);
  const [initialFrames, metadata, tab] = await Promise.all([
    inspectFrames(tabId),
    inspectMain(tabId),
    chrome.tabs.get(tabId),
  ]);
  let frames = initialFrames;
  const meta = metadata[0]?.result;
  if (!meta) return [];
  let cctvMedia: CctvMedia | undefined;
  if (meta.cctvGuid && tab.url) {
    cctvMedia = await cctvLookup(ctx, tabId, meta.identity, meta.cctvGuid, tab.url);
    const [currentTab, currentMetadata, currentFrames] = await Promise.all([
      chrome.tabs.get(tabId),
      inspectMain(tabId),
      inspectFrames(tabId),
    ]);
    const currentUrl = currentTab.pendingUrl ?? currentTab.url;
    if (
      !ctx.observation.allows(tabId, ctx.observedTaskTab()) ||
      ctx.observation.revision(tabId) !== revision ||
      !currentUrl ||
      mediaIdentity(currentUrl) !== meta.identity ||
      currentMetadata[0]?.result?.cctvGuid !== meta.cctvGuid
    )
      return [];
    frames = currentFrames;
  }
  if (meta.site === 'tencent') {
    // The page may have loaded before the panel granted an observation lease.
    // Ask the isolated bridge to replay the already-parsed MAIN-world metadata.
    await chrome.tabs.sendMessage(tabId, { type: 'player:rescan-media' }).catch(() => {});
  }
  const saved = await storedRecord(ctx.sources, 'source', tabId);
  const observed =
    saved?.expiresAt &&
    saved.expiresAt > Date.now() &&
    saved.identity === meta.identity &&
    (meta.site !== 'youtube' || youtubeSourceMatches(saved.source, meta)) &&
    (saved.source.sabrRequest || observedAudio(saved.source.url, saved.source.mime ?? ''))
      ? (saved.source as AudioSource)
      : undefined;
  // Prefer a URL that the current native player has already requested
  // successfully. Metadata can list variants the current account/CDN rejects.
  let source = observed ?? (meta.source && safeMediaUrl(meta.source.url) ? meta.source : undefined);
  if (source?.sabrRequest) source = { ...source, sabrFormats: meta.sabrFormats };
  if (source && tab.url)
    source = {
      ...source,
      headers: {
        Referer: tab.url,
        Origin: new URL(tab.url).origin,
        ...observed?.headers,
        ...source.headers,
      },
    };
  const native = meta.site === 'youtube' || meta.site === 'bilibili';
  const resources = await storedRecord(ctx.detected, 'detected', tabId);
  const items =
    resources?.expiresAt && resources.expiresAt > Date.now() && resources.identity === meta.identity
      ? resources.items.filter((item) => item.at > Date.now() - OBSERVATION_TTL_MS)
      : [];
  const candidates = await Promise.all(
    frames.flatMap((frame) => {
      // Watch-page previews and embedded players must not inherit the main
      // video's identity, audio source or playback controls.
      if (native && frame.frameId !== 0) return [];
      const scanned =
        meta.site === 'youtube'
          ? youtubePlayer(frame.result ?? [])
          : meta.site === 'bilibili'
            ? bilibiliPlayer(frame.result ?? [])
            : (frame.result ?? []);
      const visible = scanned.filter((v) => v.displayed && v.width > 100 && v.height > 60);
      const players = visible.some((v) => v.duration > 0)
        ? visible.filter((v) => v.duration > 0)
        : visible;
      const frameItems = items.filter((r) => r.frameId === frame.frameId);
      const cctvPlayer =
        frame.frameId === 0 && cctvMedia && players.filter((v) => v.cctvMain).length === 1
          ? players.find(
              (v) => v.cctvMain && !v.protected && Math.abs(v.duration - cctvMedia!.duration) <= 2,
            )
          : undefined;
      return players.map(async (v) => {
        const associated =
          cctvPlayer?.id === v.id && cctvMedia
            ? [
                {
                  url: cctvMedia.url,
                  mime: 'application/vnd.apple.mpegurl',
                  kind: 'hls' as const,
                  frameId: frame.frameId,
                  at: Date.now(),
                  headers: {},
                  playerId: v.id,
                },
                ...frameItems,
              ]
            : frameItems;
        const resolved = native
          ? { source, reason: source ? undefined : meta.sourceReason }
          : meta.cctvGuid && v.cctvMain && !cctvPlayer
            ? { reason: '央视音轨尚未就绪，请等待主视频开始后重试' }
            : chooseGenericSource(v, associated, meta.identity, players.length);
        const reason = v.protected ? '检测到受保护视频，暂不支持提前翻译' : resolved.reason;
        let selectedSource = v.protected ? undefined : resolved.source;
        // The fixed CCTV API binds public CDN mirrors to one verified GUID.
        // A refreshed/rotated CDN must not invalidate the same video's cache.
        const identitySource =
          selectedSource &&
          cctvPlayer?.id === v.id &&
          cctvMedia &&
          selectedSource.url === cctvMedia.url
            ? {
                ...selectedSource,
                url: `${CCTV_IDENTITY_API}${cctvMedia.guid}`,
                trackId: `cctv:${cctvMedia.guid}:original`,
              }
            : selectedSource;
        const identity =
          !native && identitySource
            ? await mediaResourceIdentity(meta.identity, v.frameUrl, identitySource)
            : meta.identity;
        if (selectedSource) selectedSource = { ...selectedSource, identity };
        return {
          ...v,
          tabId,
          frameId: frame.frameId,
          frameMediaId: mediaIdentity(v.frameUrl),
          site: meta.site,
          mediaId: identity,
          pageId: meta.identity,
          title: meta.title,
          ad: meta.ad,
          source: selectedSource,
          sourceReason: reason,
          detectedMedia: countKinds(frameItems),
          sourceStatus: selectedSource ? 'ready' : reason ? 'unsupported' : 'discovering',
        } as MediaCandidate;
      });
    }),
  );
  // Show observed streams even when the site has not exposed a controllable
  // video element. Discovery alone must not imply synchronous playback support.
  for (const frameId of new Set(items.map((r) => r.frameId))) {
    if (meta.site === 'youtube') continue;
    if (candidates.some((c) => c.frameId === frameId)) continue;
    const frameItems = items.filter((r) => r.frameId === frameId);
    for (const { kind, count } of countKinds(frameItems)) {
      candidates.push({
        id: `request:${frameId}:${kind}`,
        mediaId: meta.identity,
        tabId,
        frameId,
        site: meta.site,
        title: `${meta.title} · ${kind.toUpperCase()}`,
        poster: '',
        duration: 0,
        currentTime: 0,
        width: 0,
        height: 0,
        paused: true,
        ad: false,
        detectionOnly: true,
        sourceStatus: 'unsupported',
        sourceReason: '媒体资源已发现，暂未找到可控制的网页播放器',
        detectedMedia: [{ kind, count }],
      });
    }
  }
  const active = ctx.session;
  if (active?.candidate.tabId === tabId && !isFinished(active)) {
    const current = candidates.find(
      (c) => c.id === active.candidate.id && c.frameId === active.candidate.frameId,
    );
    const youtubeTrackChanged =
      meta.site === 'youtube' &&
      ((meta.currentAudioTrackId &&
        meta.currentAudioTrackId !== active.candidate.source?.trackId) ||
        (current?.source && current.source.trackId !== active.candidate.source?.trackId));
    if ((current?.source && current.mediaId !== active.candidate.mediaId) || youtubeTrackChanged)
      await stopSession(ctx, active.id);
  }
  return candidates;
}
