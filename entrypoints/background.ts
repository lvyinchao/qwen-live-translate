import { SessionTransitions } from '../lib/async-lifecycle';
import { parseTencentMedia } from '../lib/tencent-media';
import { fetchCctvMedia, type CctvMedia } from '../lib/cctv-media';
import {
  inspectVideos,
  mediaKind,
  chooseGenericSource,
  youtubePlayer,
  bilibiliPlayer,
  type ObservedMedia,
} from '../lib/discovery';
import { acceptEngineState } from '../lib/session';
import { captionPreferences, mergeCaptionPreferences } from '../lib/captions';
import { normalizeUILanguage, t } from '../lib/i18n';
import {
  inspectPlayerMain,
  mediaIdentity,
  normalizeAudioRequest,
  observedAudio,
  youtubeSourceMatches,
} from '../lib/adapters';
import {
  AUTH_RULE,
  authRule,
  endpoint,
  publicSettings,
  safeMediaUrl,
} from '../lib/security';
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  messageError,
  type AudioSource,
  type Envelope,
  type MediaCandidate,
  type PlaybackSession,
  type Settings,
  type UILanguage,
} from '../lib/types';
import { encode64 } from '../lib/audio';
import { decode64 } from '../lib/audio';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { candidatePageId, mediaResourceIdentity } from '../lib/media-identity';
import { ObservationScope } from '../lib/observation-scope';
import { registerMediaObserver, type SourceRecord, type DiscoveryRecord } from '../lib/media-observer';

export default defineBackground(() => {
  const sources = new Map<number, SourceRecord>();
  const detected = new Map<number, DiscoveryRecord>();
  const cctvSources = new Map<number, {
    identity: string; guid: string; expiresAt: number;
    value: Promise<CctvMedia | undefined>;
  }>();
  const observation = new ObservationScope();
  const panels = new Map<chrome.runtime.Port, { tabId?: number; windowId?: number }>();
  const captureStats = { responses: 0, accepted: 0, lastError: '' };
  let offscreenCreating: Promise<void> | undefined;
  let mediaRuleId = 920000;
  const rules = new Map<string, number>();
  let session: PlaybackSession | null = null;
  const transitions = new SessionTransitions();
  let languageRequest = 0;
  const observedTaskTab = () => session && !['error', 'ended'].includes(session.phase)
    ? session.candidate.tabId : undefined;
  const trusted = (sender: chrome.runtime.MessageSender) =>
    sender.id === chrome.runtime.id &&
    !!sender.url?.startsWith(chrome.runtime.getURL(''));
  const cleanRules = async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = existing
      .filter((r) => r.id >= 910000 && r.id < 930000)
      .map((r) => r.id);
    if (ids.length)
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ids,
      });
    rules.clear();
  };
  const initialize = async () => {
    await chrome.storage.local.setAccessLevel({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.action.setTitle({
      title: t((await loadSettings()).uiLanguage, '打开听译 · 原音色视频翻译'),
    });
    const saved = (await chrome.storage.session.get('activeSession'))
      .activeSession as PlaybackSession | undefined;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (saved && contexts.length) {
      session = { ...saved, ...captionPreferences(saved) };
      for (const rule of await chrome.declarativeNetRequest.getSessionRules()) {
        const domain = rule.condition.requestDomains?.[0];
        if (rule.id >= 920000 && rule.id < 930000 && domain) {
          rules.set(domain, rule.id);
          mediaRuleId = Math.max(mediaRuleId, rule.id);
        }
      }
    } else {
      await cleanRules();
      await chrome.storage.session.remove('activeSession');
    }
    // Observation leases do not survive worker shutdown. Do not revive signed
    // media URLs collected by an old panel or an unrelated page.
    await pruneObservations();
  };
  const initialized = initialize();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const previous =
      (changes.settings.oldValue as Partial<Settings> | undefined)
        ?.autoSaveFiles === true;
    const next =
      (changes.settings.newValue as Partial<Settings> | undefined)
        ?.autoSaveFiles === true;
    if (previous === next) return;
    void (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (contexts.length)
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'files:configure',
        });
    })().catch(() => {});
  });
  async function ensureOffscreen() {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    // Chrome exposes a newly created context before its scripts finish loading.
    // Concurrent callers must share the pending creation before trusting it.
    if (offscreenCreating) return offscreenCreating;
    if (existing.length) return;
    offscreenCreating ??= chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [
          chrome.offscreen.Reason.BLOBS,
          chrome.offscreen.Reason.WORKERS,
        ],
        justification:
          'Decode media audio in a worker and maintain bounded Blob caches for the active translation task',
      })
      .finally(() => {
        offscreenCreating = undefined;
      });
    await offscreenCreating;
  }
  const loadSettings = async (): Promise<Settings> => {
    const saved = (await chrome.storage.local.get('settings')).settings as
      | Partial<Settings>
      | undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      uiLanguage: normalizeUILanguage(saved?.uiLanguage),
      autoSaveFiles: saved?.autoSaveFiles === true,
    };
  };
  async function publishLocale(language: UILanguage) {
    await chrome.action.setTitle({ title: t(language, '打开听译 · 原音色视频翻译') });
    const tabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) =>
          chrome.tabs.sendMessage(tab.id!, { type: 'ui:changed', language }),
        ),
    );
  }
  async function toPlayer(type: string, data: Record<string, unknown> = {}, owner = session) {
    if (!owner) return;
    try {
      const reply = await chrome.tabs.sendMessage(
        owner.candidate.tabId,
        { type, sessionId: owner.id, ...data },
        { frameId: owner.candidate.frameId },
      );
      // Diagnostic transport must not turn an acknowledged media delivery into
      // a playback failure. The normal event channel also submits these records.
      await forwardTerminals(owner, reply?.terminals).catch(() => {});
      return reply;
    } catch {
      /* Navigation is handled by the session owner. */
    }
  }
  async function forwardTerminals(owner: PlaybackSession, entries: unknown) {
    if (!Array.isArray(entries)) return;
    const events = entries.filter((event) => event && event.type === 'player:metric' &&
      event.kind === 'terminal' && event.sessionId === owner.id &&
      Number.isInteger(event.epoch) && event.epoch <= owner.epoch &&
      Number.isInteger(event.languageVersion ?? 0) &&
      (event.languageVersion ?? 0) <= (owner.languageVersion ?? 0));
    if (events.length) await chrome.runtime.sendMessage({ target: 'offscreen',
      type: 'engine:terminals', sessionId: owner.id, events });
  }
  function releaseObservation(tabId: number) {
    observation.release(tabId);
    sources.delete(tabId);
    detected.delete(tabId);
    cctvSources.delete(tabId);
    void chrome.storage.session.remove([`source:${tabId}`, `detected:${tabId}`]);
  }
  async function pruneObservations() {
    for (const id of observation.expired()) if (observedTaskTab() !== id) releaseObservation(id);
    const now = Date.now();
    const persisted = await chrome.storage.session.get(null);
    const expired = Object.entries(persisted).filter(([key, value]) => {
      if (!/^(?:source|detected):\d+$/.test(key)) return false;
      const tabId = Number(key.split(':')[1]);
      const record = value as SourceRecord | DiscoveryRecord;
      return !observation.allows(tabId, observedTaskTab()) || !record.expiresAt || record.expiresAt <= now;
    }).map(([key]) => key);
    for (const key of expired) {
      const id = Number(key.split(':')[1]);
      (key.startsWith('source:') ? sources : detected).delete(id);
    }
    if (expired.length) await chrome.storage.session.remove(expired);
  }
  async function discover(tabId: number): Promise<MediaCandidate[]> {
    observation.watch(tabId);
    await pruneObservations();
    const revision = observation.revision(tabId);
    const [initialFrames, metadata, tab] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: inspectVideos,
      }),
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: inspectPlayerMain,
      }),
      chrome.tabs.get(tabId),
    ]);
    let frames = initialFrames;
    const meta = metadata[0]?.result;
    if (!meta) return [];
    let cctvMedia: CctvMedia | undefined;
    if (meta.cctvGuid && tab.url) {
      const stored = cctvSources.get(tabId);
      if (!stored || stored.identity !== meta.identity || stored.guid !== meta.cctvGuid || stored.expiresAt <= Date.now()) {
        const next = {
          identity: meta.identity, guid: meta.cctvGuid, expiresAt: Date.now() + 5 * 60000,
          value: fetchCctvMedia(tab.url, meta.cctvGuid),
        };
        cctvSources.set(tabId, next);
        // Briefly back off failed lookups, while allowing the panel's next scan
        // to recover from transient API/network errors instead of caching them.
        void next.value.then((value) => { if (!value) next.expiresAt = Date.now() + 2000; });
      }
      cctvMedia = await cctvSources.get(tabId)!.value;
      const [currentTab, currentMetadata, currentFrames] = await Promise.all([
        chrome.tabs.get(tabId),
        chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', func: inspectPlayerMain}),
        chrome.scripting.executeScript({target: {tabId, allFrames: true}, world: 'ISOLATED', func: inspectVideos}),
      ]);
      const currentUrl = currentTab.pendingUrl ?? currentTab.url;
      if (!observation.allows(tabId, observedTaskTab()) ||
          observation.revision(tabId) !== revision ||
          !currentUrl || mediaIdentity(currentUrl) !== meta.identity ||
          currentMetadata[0]?.result?.cctvGuid !== meta.cctvGuid) return [];
      frames = currentFrames;
    }
    if (meta.site === 'tencent') {
      // The page may have loaded before the panel granted an observation lease.
      // Ask the isolated bridge to replay the already-parsed MAIN-world metadata.
      await chrome.tabs.sendMessage(tabId, {type: 'player:rescan-media'}).catch(() => {});
    }
    const saved = (sources.get(tabId) ??
      (await chrome.storage.session.get(`source:${tabId}`))[
        `source:${tabId}`
      ]) as SourceRecord | undefined;
    const observed =
      saved?.expiresAt && saved.expiresAt > Date.now() && saved.identity === meta.identity &&
      (meta.site !== 'youtube' || youtubeSourceMatches(saved.source, meta)) &&
      (saved.source.sabrRequest ||
        observedAudio(saved.source.url, saved.source.mime ?? ''))
        ? (saved.source as AudioSource)
        : undefined;
    // Prefer a URL that the current native player has already requested
    // successfully. Metadata can list variants the current account/CDN rejects.
    let source =
      observed ??
      (meta.source && safeMediaUrl(meta.source.url) ? meta.source : undefined);
    if (source?.sabrRequest)
      source = { ...source, sabrFormats: meta.sabrFormats };
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
    const resources =
      detected.get(tabId) ??
      ((await chrome.storage.session.get(`detected:${tabId}`))[
        `detected:${tabId}`
      ] as DiscoveryRecord | undefined);
    const items = resources?.expiresAt && resources.expiresAt > Date.now() && resources.identity === meta.identity
      ? resources.items.filter((item) => item.at > Date.now() - 60000) : [];
    const candidates = await Promise.all(frames.flatMap((frame) => {
      // Watch-page previews and embedded players must not inherit the main
      // video's identity, audio source or playback controls.
      if (native && frame.frameId !== 0) return [];
      const scanned =
        meta.site === 'youtube'
          ? youtubePlayer(frame.result ?? [])
          : meta.site === 'bilibili' ? bilibiliPlayer(frame.result ?? []) : (frame.result ?? []);
      const visible = scanned.filter(
        (v) => v.displayed && v.width > 100 && v.height > 60,
      );
      const players = visible.some((v) => v.duration > 0)
        ? visible.filter((v) => v.duration > 0)
        : visible;
      const frameItems = items.filter((r) => r.frameId === frame.frameId);
      const cctvPlayer = frame.frameId === 0 && cctvMedia &&
        players.filter((v) => v.cctvMain).length === 1
        ? players.find((v) => v.cctvMain && !v.protected &&
          Math.abs(v.duration - cctvMedia!.duration) <= 2) : undefined;
      return players.map(async (v) => {
        const associated = cctvPlayer?.id === v.id && cctvMedia ? [{
          url: cctvMedia.url, mime: 'application/vnd.apple.mpegurl', kind: 'hls' as const,
          frameId: frame.frameId, at: Date.now(), headers: {}, playerId: v.id,
        }, ...frameItems] : frameItems;
        const resolved = native
          ? { source, reason: source ? undefined : meta.sourceReason }
          : meta.cctvGuid && v.cctvMain && !cctvPlayer
            ? { reason: '央视音轨尚未就绪，请等待主视频开始后重试' }
          : chooseGenericSource(v, associated, meta.identity, players.length);
        const reason = v.protected
          ? '检测到受保护视频，暂不支持提前翻译'
          : resolved.reason;
        let selectedSource = v.protected ? undefined : resolved.source;
        // The fixed CCTV API binds public CDN mirrors to one verified GUID.
        // A refreshed/rotated CDN must not invalidate the same video's cache.
        const identitySource = selectedSource && cctvPlayer?.id === v.id && cctvMedia &&
          selectedSource.url === cctvMedia.url
          ? { ...selectedSource, url: `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=${cctvMedia.guid}`,
            trackId: `cctv:${cctvMedia.guid}:original` }
          : selectedSource;
        const identity = !native && identitySource
          ? await mediaResourceIdentity(meta.identity, v.frameUrl, identitySource)
          : meta.identity;
        if (selectedSource) selectedSource = {...selectedSource, identity};
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
          detectedMedia: [...new Set(frameItems.map((r) => r.kind))].map(
            (kind) => ({
              kind,
              count: frameItems.filter((r) => r.kind === kind).length,
            }),
          ),
          sourceStatus: selectedSource
            ? 'ready'
            : reason
              ? 'unsupported'
              : 'discovering',
        } as MediaCandidate;
      });
    }));
    // Show observed streams even when the site has not exposed a controllable
    // video element. Discovery alone must not imply synchronous playback support.
    for (const frameId of new Set(items.map((r) => r.frameId))) {
      if (meta.site === 'youtube') continue;
      if (candidates.some((c) => c.frameId === frameId)) continue;
      const frameItems = items.filter((r) => r.frameId === frameId);
      for (const kind of new Set(frameItems.map((r) => r.kind))) {
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
          detectedMedia: [
            { kind, count: frameItems.filter((r) => r.kind === kind).length },
          ],
        });
      }
    }
    const active = session;
    if (active?.candidate.tabId === tabId && !['error', 'ended'].includes(active.phase)) {
      const current = candidates.find((c) => c.id === active.candidate.id && c.frameId === active.candidate.frameId);
      const youtubeTrackChanged = meta.site === 'youtube' &&
        ((meta.currentAudioTrackId && meta.currentAudioTrackId !== active.candidate.source?.trackId) ||
          (current?.source && current.source.trackId !== active.candidate.source?.trackId));
      if ((current?.source && current.mediaId !== active.candidate.mediaId) || youtubeTrackChanged)
        await stop(active.id);
    }
    return candidates;
  }
  const stopOwned = async (previous: PlaybackSession | null, detached?: Promise<unknown>) => {
    if (previous && session?.id === previous.id) session = null;
    await (detached ?? (previous ? toPlayer('player:stop', {}, previous) : Promise.resolve()));
    if (previous) await chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'engine:stop', sessionId: previous.id })
      .catch(() => {});
    if (previous && ![...panels.values()].some((p) => p.tabId === previous.candidate.tabId))
      releaseObservation(previous.candidate.tabId);
    // A new start cannot overtake this cleanup: all lifecycle work shares a queue.
    if (!session) {
      await chrome.storage.session.remove('activeSession');
      await cleanRules();
      void chrome.runtime.sendMessage({ type: 'session:updated', session: null }).catch(() => {});
    }
  };
  const stop = (expectedId?: string): Promise<void> => {
    if (expectedId && session?.id !== expectedId) return Promise.resolve();
    transitions.invalidate();
    languageRequest++;
    const previous = session;
    session = null;
    const detached = previous ? toPlayer('player:stop', {}, previous) : Promise.resolve();
    return transitions.run(() => stopOwned(previous, detached));
  };
  registerMediaObserver({scope: observation, sources, detected, captureStats, getSession: () => observedTaskTab() !== undefined ? session : null, stop: () => stop()});
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'timbradub-panel' || !port.sender || !trusted(port.sender)) return;
    const watch: {tabId?: number; windowId?: number} = {};
    panels.set(port, watch);
    port.onMessage.addListener((message) => {
      if (message.type !== 'watch' || !Number.isInteger(message.tabId)) return;
      if (watch.tabId !== undefined && watch.tabId !== message.tabId && observedTaskTab() !== watch.tabId)
        releaseObservation(watch.tabId);
      watch.tabId = message.tabId;
      watch.windowId = message.windowId;
      observation.watch(message.tabId);
    });
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      if (watch.tabId !== undefined && ![...panels.values()].some((p) => p.tabId === watch.tabId) && observedTaskTab() !== watch.tabId)
        releaseObservation(watch.tabId);
    });
  });
  chrome.tabs.onActivated.addListener(({tabId, windowId}) => {
    for (const watch of panels.values()) if (watch.windowId === undefined || watch.windowId === windowId) {
      if (watch.tabId !== undefined && watch.tabId !== tabId && observedTaskTab() !== watch.tabId) releaseObservation(watch.tabId);
      watch.tabId = tabId;
      observation.watch(tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((id) => {
    observation.release(id);
    sources.delete(id);
    detected.delete(id);
    cctvSources.delete(id);
    void chrome.storage.session.remove([`source:${id}`, `detected:${id}`]);
    if (session?.candidate.tabId === id) void stop();
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === 'loading') {
      // A same-URL reload is a new document too: its old pending metadata may
      // not repopulate discovery merely because the GUID remains unchanged.
      observation.invalidate(id);
      cctvSources.delete(id);
    }
    if (change.url) {
      observation.invalidate(id);
      if (detected.get(id)?.identity !== mediaIdentity(change.url)) {
        detected.delete(id);
        void chrome.storage.session.remove(`detected:${id}`);
      }
      const old = sources.get(id);
      if (old && old.identity !== mediaIdentity(change.url)) {
        sources.delete(id);
        void chrome.storage.session.remove(`source:${id}`);
      }
      if (
        session?.candidate.tabId === id &&
        candidatePageId(session.candidate) !== mediaIdentity(change.url)
      )
        void stop();
    }
  });
  chrome.runtime.onMessage.addListener((message: Envelope, sender, respond) => {
    if (
      message.target === 'offscreen' ||
      message.type === 'session:updated' ||
      message.type === 'files:updated' ||
      message.type === 'sources:updated'
    )
      return;
    void (async () => {
      await initialized;
      const privileged = trusted(sender);
      switch (message.type) {
        case 'files:set-enabled': {
          if (!privileged) throw new Error('不允许网页修改配置');
          return transitions.run(async () => {
          const next = {
            ...(await loadSettings()),
            autoSaveFiles: message.enabled === true,
          };
          await chrome.storage.local.set({ settings: next });
          await ensureOffscreen();
          const configured = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'files:configure',
          });
          if (!configured?.ok)
            throw new Error(configured?.error ?? '本地保存暂不可用');
          return publicSettings(await loadSettings());
          });
        }
        case 'files:status':
        case 'files:merge':
        case 'files:retry': {
          if (!privileged) throw new Error('不允许网页读取本地保存内容');
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: message.type,
          });
          if (!result?.ok) throw new Error(result?.error ?? '本地保存暂不可用');
          return result.value;
        }
        case 'files:show': {
          if (!privileged) throw new Error('不允许网页读取本地保存内容');
          const id = Number(message.id);
          if (!Number.isInteger(id)) throw new Error('本地文件不存在');
          const [item] = await chrome.downloads.search({ id });
          if (!item || item.byExtensionId !== chrome.runtime.id)
            throw new Error('本地文件不存在');
          await chrome.downloads.show(id);
          return true;
        }
        case 'files:download': {
          if (
            !privileged ||
            sender.url !== chrome.runtime.getURL('offscreen.html')
          )
            throw new Error('不允许网页保存文件');
          const url = String(message.url),
            filename = String(message.filename);
          if (
            !url.startsWith(`blob:${chrome.runtime.getURL('')}`) ||
            !filename.startsWith('TimbraDub/') ||
            !filename.endsWith('.zip') ||
            /[\\\x00-\x1f]/.test(filename) ||
            filename.split('/').some((p) => !p || p === '.' || p === '..')
          )
            throw new Error('本地保存路径无效');
          return new Promise<number>((resolve, reject) => {
            let id: number | undefined;
            const cleanup = () => {
              clearTimeout(timer);
              chrome.downloads.onChanged.removeListener(changed);
            };
            const changed = (delta: chrome.downloads.DownloadDelta) => {
              if (delta.id !== id) return;
              if (delta.state?.current === 'complete') {
                cleanup();
                resolve(id);
              }
              if (delta.state?.current === 'interrupted') {
                cleanup();
                reject(new Error('本地文件保存中断，请重试'));
              }
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error('本地文件保存超时，请重试'));
            }, 90000);
            chrome.downloads.onChanged.addListener(changed);
            void chrome.downloads
              .download({
                url,
                filename,
                saveAs: false,
                conflictAction: 'uniquify',
              })
              .then(async (value) => {
                id = value;
                const [item] = await chrome.downloads.search({ id });
                if (item?.state === 'complete') {
                  cleanup();
                  resolve(id);
                } else if (item?.state === 'interrupted') {
                  cleanup();
                  reject(new Error('本地文件保存中断，请重试'));
                }
              })
              .catch((error) => {
                cleanup();
                reject(error);
              });
          });
        }
        case 'ui:get':
          // Content scripts can read only this presentation preference.
          return (await loadSettings()).uiLanguage;
        case 'ui:set': {
          if (!privileged) throw new Error('不允许网页修改配置');
          const language = message.language;
          if (language !== 'en' && language !== 'zh')
            throw new Error('无效的界面语言');
          return transitions.run(async () => {
          const next: Settings = {
            ...(await loadSettings()),
            uiLanguage: language,
          };
          await chrome.storage.local.set({ settings: next });
          await publishLocale(next.uiLanguage);
          return next.uiLanguage;
          });
        }
        case 'settings:get':
          if (!privileged) throw new Error('不允许网页读取配置');
          return publicSettings(await loadSettings());
        case 'settings:save': {
          if (!privileged) throw new Error('不允许网页修改配置');
          return transitions.run(async () => {
          const input = message.settings as Partial<Settings>,
            current = await loadSettings();
          const next = {
            ...current,
            ...input,
            apiKey: input.apiKey?.trim() || current.apiKey,
            autoSaveFiles:
              input.autoSaveFiles === undefined
                ? current.autoSaveFiles
                : input.autoSaveFiles === true,
          };
          endpoint(next);
          if (observedTaskTab() !== undefined &&
              (next.apiKey !== current.apiKey || next.workspace !== current.workspace || next.region !== current.region))
            throw new Error('请先停止翻译，再修改服务凭据');
          if (!LANGUAGES.some(([code]) => code === next.language))
            throw new Error('无效的目标语言');
          if (next.uiLanguage !== 'en' && next.uiLanguage !== 'zh')
            throw new Error('无效的界面语言');
          await chrome.storage.local.set({ settings: next });
          if (next.uiLanguage !== current.uiLanguage)
            await publishLocale(next.uiLanguage);
          return publicSettings(next);
          });
        }
        case 'settings:forget': {
          if (!privileged) throw new Error('不允许网页修改配置');
          const stopping = stop();
          return transitions.run(async () => {
          await stopping;
          const current = await loadSettings();
          const next = {
            ...DEFAULT_SETTINGS,
            language: current.language,
            uiLanguage: current.uiLanguage,
            autoSaveFiles: current.autoSaveFiles,
          };
          await chrome.storage.local.set({ settings: next });
          return publicSettings(next);
          });
        }
        case 'settings:test': {
          if (!privileged) throw new Error('不允许网页测试凭据');
          return transitions.run(async () => {
            if (session) throw new Error('请先停止翻译再测试连接');
            await ensureOffscreen();
            const settings = await loadSettings();
            if (session) throw new Error('请先停止翻译再测试连接');
            return chrome.runtime.sendMessage({target: 'offscreen', type: 'engine:probe', settings});
          });
        }
        case 'media:tencent-info': {
          if (!sender.tab?.id || !sender.url?.startsWith('https://v.qq.com/'))
            throw new Error('不允许网页触发扫描');
          if (!observation.allows(sender.tab.id, observedTaskTab())) return false;
          const observedRevision = observation.revision(sender.tab.id);
          const stillObserved = () => observation.allows(sender.tab!.id!, observedTaskTab()) && observation.revision(sender.tab!.id!) === observedRevision;
          const tab = await chrome.tabs.get(sender.tab.id);
          if (!tab.url || !stillObserved()) return false;
          const supplied = message.media as {
            videoId?: string;
            url?: string;
            playlist?: string;
            protected?: boolean;
            playerId?: string;
          };
          const validated = parseTencentMedia(
            JSON.stringify({
              vinfo: {
                vl: {
                  vi: [
                    {
                      vid: supplied.videoId,
                      drm: supplied.protected ? 1 : 0,
                      ul: {
                        m3u8: supplied.playlist,
                        ui: [{ url: supplied.url }],
                      },
                    },
                  ],
                },
              },
            }),
            tab.url,
          );
          if (!validated) return false;
          const identity = mediaIdentity(tab.url);
          const previous = detected.get(sender.tab.id);
          const items = previous?.identity === identity ? previous.items : [];
          const state = {
            identity,
            expiresAt: Date.now() + 60000,
            items: [
              ...items.filter(
                (r) =>
                  r.kind !== 'hls' ||
                  r.frameId !== (sender.frameId ?? 0) ||
                  r.playerId !== supplied.playerId,
              ),
              {
                url: validated.url,
                mime: 'application/vnd.apple.mpegurl',
                kind: 'hls' as const,
                hlsManifest: validated.playlist,
                protected: validated.protected,
                playerId:
                  typeof supplied.playerId === 'string' &&
                  /^[a-zA-Z0-9-]{1,64}$/.test(supplied.playerId)
                    ? supplied.playerId
                    : undefined,
                frameId: sender.frameId ?? 0,
                at: Date.now(),
                headers: { Referer: tab.url, Origin: 'https://v.qq.com' },
              },
            ],
          };
          if (!stillObserved()) return false;
          detected.set(sender.tab.id, state);
          await chrome.storage.session.set({
            [`detected:${sender.tab.id}`]: state,
          });
          if (!stillObserved()) {
            if (!detected.has(sender.tab.id) || detected.get(sender.tab.id) === state) {
              detected.delete(sender.tab.id);
              await chrome.storage.session.remove(`detected:${sender.tab.id}`);
            }
            return false;
          }
          void chrome.runtime
            .sendMessage({ type: 'sources:updated', tabId: sender.tab.id })
            .catch(() => {});
          return true;
        }
        case 'media:discover':
          if (!privileged) throw new Error('不允许网页触发扫描');
          return discover(Number(message.tabId));
        case 'media:refresh': {
          if (
            !privileged ||
            !session ||
            session.id !== message.sessionId ||
            (session.languageVersion ?? 0) !== (message.languageVersion ?? 0) ||
            session.epoch !== message.epoch
          )
            throw new Error('翻译任务已过期');
          const fresh = sources.get(session.candidate.tabId);
          if (
            fresh?.expiresAt && fresh.expiresAt > Date.now() && fresh.identity === candidatePageId(session.candidate) &&
            (fresh.source.sabrRequest ||
              observedAudio(fresh.source.url, fresh.source.mime ?? ''))
          )
            return {
              ...session.candidate.source,
              ...fresh.source,
              sabrFormats: session.candidate.source?.sabrFormats,
            };
          const owner = session;
          if (owner.candidate.site !== 'youtube' && owner.candidate.site !== 'bilibili') {
            const candidates = await discover(owner.candidate.tabId);
            if (session?.id !== owner.id || session.epoch !== owner.epoch || session.languageVersion !== owner.languageVersion) throw new Error('翻译任务已过期');
            const current = candidates.find((c) => c.id === owner.candidate.id && c.frameId === owner.candidate.frameId);
            if (current?.source && current.mediaId === owner.candidate.mediaId) return current.source;
            if (current?.source) throw new Error('视频或音轨已变化，请重新扫描');
          }
          return owner.candidate.source;
        }
        case 'media:diagnostics':
          if (!privileged) throw new Error('不允许网页读取诊断');
          return {
            ...captureStats,
            sources: [...sources].map(([tabId, value]) => ({
              tabId,
              identity: value.identity,
              host: new URL(value.source.url).hostname,
              sabr: Boolean(value.source.sabrRequest),
              poTokenBytes: value.source.sabrRequest
                ? (VideoPlaybackAbrRequest.decode(
                    decode64(value.source.sabrRequest),
                  ).streamerContext?.poToken?.length ?? 0)
                : undefined,
            })),
          };
        case 'media:highlight':
          if (!privileged) throw new Error('不允许网页触发选择');
          await chrome.tabs.sendMessage(
            Number(message.tabId),
            { type: 'player:highlight', id: message.id },
            { frameId: Number(message.frameId) },
          );
          return true;
        case 'session:get':
          if (!privileged) return null;
          return session;
        case 'session:diagnostics':
          if (!privileged) throw new Error('不允许网页读取诊断');
          await ensureOffscreen();
          return chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'engine:diagnostics',
          });
        case 'session:start': {
          if (!privileged) throw new Error('不允许网页触发翻译');
          const ticket = transitions.invalidate();
          languageRequest++;
          return transitions.run(async () => {
            if (!transitions.current(ticket)) return session;
            await stopOwned(session);
            if (!transitions.current(ticket)) return session;
            const choice = message.candidate as MediaCandidate;
            const fresh = (await discover(choice.tabId)).find(
              (v) => v.id === choice.id && v.frameId === choice.frameId,
            );
            if (!transitions.current(ticket)) return session;
            if (!fresh) throw new Error('视频已变化，请重新扫描');
            if (fresh.sourceReason && !fresh.source) throw new Error(fresh.sourceReason);
            if (fresh.ad) throw new Error('请等待广告结束，再选择正片');
            if (!fresh.duration) throw new Error('首版仅支持普通点播视频');
            if (!fresh.source) throw new Error('尚未发现可预取的音轨。请先播放几秒，再重新扫描；本版本不会以滞后采集代替同步。');
            const settings = await loadSettings();
            endpoint(settings);
            if (!settings.apiKey) throw new Error('请先在设置中填写百炼凭据');
            const language = String(message.language ?? settings.language);
            if (!LANGUAGES.some(([code]) => code === language)) throw new Error('无效的目标语言');
            if (!transitions.current(ticket)) return session;
            const owner: PlaybackSession = {
              id: crypto.randomUUID(), epoch: 0, languageVersion: 0,
              candidate: fresh, language, phase: 'preparing', position: fresh.currentTime,
              rate: fresh.playbackRate ?? 1, readyThrough: fresh.currentTime, inputThrough: fresh.currentTime,
              skipped: 0, originalVolume: 0, dubVolume: 1,
              ...captionPreferences(), segments: [],
            };
            session = owner;
            try {
              const attached = await toPlayer('player:attach', { session: owner }, owner);
              if (!attached?.ok) throw new Error('播放器已被页面替换，请重新扫描');
              if (Number.isFinite(attached.rate) && attached.rate > 0) owner.rate = attached.rate;
              if (Number.isFinite(attached.position)) {
                owner.position = attached.position;
                owner.readyThrough = owner.inputThrough = attached.position;
              }
              if (!transitions.current(ticket)) { await stopOwned(owner); return session; }
              await ensureOffscreen();
              if (!transitions.current(ticket)) { await stopOwned(owner); return session; }
              const result = await chrome.runtime.sendMessage({target: 'offscreen', type: 'engine:start', session: owner, settings});
              if (result?.ok !== true) throw new Error(result?.error ?? '翻译启动失败，请重试');
              if (!transitions.current(ticket)) { await stopOwned(owner); return session; }
              return session;
            } catch (error) {
              await stopOwned(owner).catch(() => {});
              throw error;
            }
          });
        }
        case 'session:language': {
          if (!privileged) throw new Error('不允许网页触发翻译');
          const request = ++languageRequest;
          return transitions.run(async () => {
          if (request !== languageRequest) return session;
          const language = String(message.language);
          if (!LANGUAGES.some(([code]) => code === language))
            throw new Error('无效的目标语言');
          if (!session || session.id !== message.sessionId)
            throw new Error('翻译任务已过期');
          if (session.language === language) return session;
          // Invalidate the old language before the first asynchronous step.
          const next: PlaybackSession = {
            ...session,
            language,
            epoch: session.epoch + 1,
            languageVersion: (session.languageVersion ?? 0) + 1,
            phase: 'buffering',
            readyThrough: session.position,
            inputThrough: session.position,
            skipped: 0,
            segments: [],
            error: undefined,
            diagnostic: undefined,
          };
          session = next;
          try {
          const clock = await toPlayer('player:language', { session: next }, next);
          if (session !== next) return session;
          if (!clock?.ok) {
            await stopOwned(next);
            throw new Error('播放器已被页面替换，请重新扫描');
          }
          next.position = clock.position;
          next.rate = clock.rate;
          next.readyThrough = next.inputThrough = clock.position;
          await chrome.storage.session.set({ activeSession: next });
          if (session !== next) return session;
          void chrome.runtime
            .sendMessage({ type: 'session:updated', session: next })
            .catch(() => {});
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'engine:language',
            session: next,
            userPaused: clock.userPaused,
          });
          if (
            session?.id !== next.id ||
            session.epoch !== next.epoch ||
            session.language !== language
          )
            return session;
          if (result?.ok !== true) {
            await stopOwned(next);
            throw new Error(result?.error ?? '翻译启动失败，请重试');
          }
          return session;
          } catch (error) {
            if (session?.id === next.id) await stopOwned(next).catch(() => {});
            throw error;
          }
          });
        }
        case 'session:stop':
          if (!privileged) throw new Error('不允许网页停止翻译');
          await stop();
          return true;
        case 'session:mix': {
          if (!privileged || !session || (message.sessionId && message.sessionId !== session.id) ||
            (message.languageVersion !== undefined && message.languageVersion !== (session.languageVersion ?? 0))) return false;
          const owner = session;
          const clamp = (value: unknown, previous: number) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : previous;
          owner.originalVolume = clamp(message.originalVolume, owner.originalVolume);
          owner.dubVolume = clamp(message.dubVolume, owner.dubVolume);
          Object.assign(owner, mergeCaptionPreferences(owner, message));
          await chrome.storage.session.set({ activeSession: owner });
          const changes = {sessionId: owner.id, languageVersion: owner.languageVersion ?? 0, originalVolume: owner.originalVolume, dubVolume: owner.dubVolume, ...captionPreferences(owner)};
          await chrome.runtime.sendMessage({target: 'offscreen', type: 'engine:mix', ...changes});
          if (session?.id === owner.id) await toPlayer('player:mix', changes, owner);
          return true;
        }
        case 'auth:install':
          if (!privileged) throw new Error('不允许网页安装鉴权规则');
          if (
            message.sessionId &&
            (session?.id !== message.sessionId ||
              (session.languageVersion ?? 0) !==
                (message.languageVersion ?? 0) ||
              session.epoch !== message.epoch)
          )
            throw new Error('翻译任务已过期');
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [AUTH_RULE],
            addRules: [authRule(await loadSettings(), chrome.runtime.id)],
          });
          return endpoint(await loadSettings());
        case 'auth:remove':
          if (!privileged) throw new Error('不允许网页修改鉴权规则');
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [AUTH_RULE],
          });
          return true;
        case 'media:headers': {
          if (!privileged) throw new Error('不允许网页修改请求规则');
          if (message.sessionId && (session?.id !== message.sessionId || session.epoch !== message.epoch ||
              (session.languageVersion ?? 0) !== (message.languageVersion ?? 0)))
            throw new Error('翻译任务已过期');
          const source = message.source as AudioSource;
          if (!safeMediaUrl(source.url, true))
            throw new Error('媒体域名不在允许范围');
          if (!Object.keys(source.headers ?? {}).length) return true;
          const exactHost = new URL(source.url).hostname;
          const host =
            [
              'googlevideo.com',
              'bilivideo.com',
              'bilivideo.cn',
              'akamaized.net',
            ].find((d) => exactHost === d || exactHost.endsWith('.' + d)) ??
            exactHost;
          const id = rules.get(host) ?? ++mediaRuleId;
          rules.set(host, id);
          const headers = Object.entries(source.headers ?? {})
            .filter(([name]) =>
              ['origin', 'referer'].includes(name.toLowerCase()),
            )
            .map(([header, value]) => ({
              header,
              operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
              value,
            }));
          if (headers.length)
            await chrome.declarativeNetRequest.updateSessionRules({
              removeRuleIds: [id],
              addRules: [
                {
                  id,
                  priority: 10,
                  action: {
                    type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
                    requestHeaders: headers,
                  },
                  condition: {
                    initiatorDomains: [chrome.runtime.id],
                    requestDomains: [host],
                    resourceTypes: [
                      'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
                    ],
                  },
                },
              ],
            });
          return true;
        }
        case 'engine:state':
          if (!privileged) return false;
          const accepted = acceptEngineState(
            session,
            message.session as PlaybackSession,
          );
          if (accepted) {
            session = accepted;
            if (['error', 'ended'].includes(accepted.phase) &&
                ![...panels.values()].some((panel) => panel.tabId === accepted.candidate.tabId))
              releaseObservation(accepted.candidate.tabId);
            await chrome.storage.session.set({ activeSession: accepted });
            if (session !== accepted) return false;
            if (['error', 'ended'].includes(accepted.phase)) {
              // Rule cleanup is serialized with starts; an old error cannot
              // remove the next task's authentication or media headers.
              void transitions.run(async () => {
                if (session === accepted) await cleanRules();
              });
            }
            await toPlayer('player:state', { session: accepted }, accepted);
            if (session === accepted) void chrome.runtime
              .sendMessage({ type: 'session:updated', session: accepted })
              .catch(() => {});
          }
          return true;
        case 'engine:segment':
          if (
            !privileged ||
            !session ||
            session.id !== message.sessionId ||
            (session.languageVersion ?? 0) !== (message.languageVersion ?? 0) ||
            session.epoch !== message.epoch ||
            (message.segment as { language?: string })?.language !==
              session.language
          )
            return false;
          const owner = session;
          const delivered = await toPlayer('player:segment', {
            segment: message.segment,
            epoch: message.epoch,
            languageVersion: message.languageVersion,
          }, owner);
          return delivered?.ok === true;
        case 'player:clock':
        case 'player:seek':
        case 'player:lost':
        case 'player:skip':
        case 'player:metric':
          if (
            !session ||
            sender.tab?.id !== session.candidate.tabId ||
            sender.frameId !== session.candidate.frameId ||
            message.sessionId !== session.id
          )
            return false;
          if (message.type === 'player:lost') {
            await forwardTerminals(session, message.terminals).catch(() => {});
            await stop();
            return true;
          }
          return chrome.runtime.sendMessage({
            ...message,
            target: 'offscreen',
          });
        case 'storage:summary':
        case 'cache:clear':
        case 'media:clear':
        case 'archives:clear': {
          if (!privileged) throw new Error('不允许网页清理缓存');
          const operation = async () => {
            if (message.type !== 'storage:summary' && session) throw new Error('请先停止翻译，再清理缓存');
            await ensureOffscreen();
            const result = await chrome.runtime.sendMessage({target: 'offscreen', type: message.type});
            if (!result?.ok) throw new Error(result?.error ?? '本地保存暂不可用');
            return result.value;
          };
          return message.type === 'storage:summary' ? operation() : transitions.run(operation);
        }
        default:
          return undefined;
      }
    })().then(
      (value) => respond({ ok: true, value }),
      (error) => respond({ ok: false, error: messageError(error) }),
    );
    return true;
  });
});
