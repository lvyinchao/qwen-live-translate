import { acceptEngineState } from '../lib/session';
import { normalizeUILanguage, t } from '../lib/i18n';
import {
  inspectPlayerMain,
  mediaIdentity,
  normalizeAudioRequest,
  observedAudio,
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

export default defineBackground(() => {
  const sources = new Map<number, { identity: string; source: AudioSource }>();
  const requests = new Map<string, Record<string, string>>();
  const bodies = new Map<string, string>();
  const scopes = new Map<string, Promise<string | undefined>>();
  const captureStats = { responses: 0, accepted: 0, lastError: '' };
  let offscreenCreating: Promise<void> | undefined;
  let mediaRuleId = 920000;
  const rules = new Map<string, number>();
  let session: PlaybackSession | null = null;
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
      title: t((await loadSettings()).uiLanguage, '打开听译'),
    });
    const saved = (await chrome.storage.session.get('activeSession'))
      .activeSession as PlaybackSession | undefined;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (saved && contexts.length) {
      session = saved;
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
  };
  const initialized = initialize();
  async function ensureOffscreen() {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
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
    };
  };
  async function publishLocale(language: UILanguage) {
    await chrome.action.setTitle({ title: t(language, '打开听译') });
    const tabs = await chrome.tabs.query({
      url: ['*://*.youtube.com/*', '*://*.bilibili.com/*'],
    });
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) =>
          chrome.tabs.sendMessage(tab.id!, { type: 'ui:changed', language }),
        ),
    );
  }
  async function toPlayer(type: string, data: Record<string, unknown> = {}) {
    if (!session) return;
    try {
      return await chrome.tabs.sendMessage(
        session.candidate.tabId,
        { type, ...data },
        { frameId: session.candidate.frameId },
      );
    } catch {
      /* Navigation is handled by the session owner. */
    }
  }
  async function discover(tabId: number): Promise<MediaCandidate[]> {
    const [frames, metadata, tab] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: () =>
          Array.from(document.querySelectorAll('video')).map((v, i) => {
            const id = (v.dataset.qvdId ??= crypto.randomUUID());
            return {
              id,
              title: document.title,
              poster: v.poster,
              duration: Number.isFinite(v.duration) ? v.duration : 0,
              currentTime: v.currentTime,
              width: v.videoWidth || v.clientWidth,
              height: v.videoHeight || v.clientHeight,
              paused: v.paused,
              index: i,
            };
          }),
      }),
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: inspectPlayerMain,
      }),
      chrome.tabs.get(tabId),
    ]);
    const meta = metadata[0]?.result;
    if (!meta) return [];
    const saved = (sources.get(tabId) ??
      (await chrome.storage.session.get(`source:${tabId}`))[
        `source:${tabId}`
      ]) as { identity: string; source: AudioSource } | undefined;
    const observed =
      saved?.identity === meta.identity
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
    return frames.flatMap((frame) =>
      (frame.result ?? [])
        .filter((v) => v.width > 100 && v.height > 60)
        .map(
          (v) =>
            ({
              ...v,
              tabId,
              frameId: frame.frameId,
              site: meta.site,
              mediaId: meta.identity,
              title: meta.title,
              ad: meta.ad,
              source,
              sourceStatus: source ? 'ready' : 'discovering',
            }) as MediaCandidate,
        ),
    );
  }
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (
        details.tabId < 0 ||
        details.initiator?.startsWith('chrome-extension:')
      )
        return undefined;
      scopes.set(
        details.requestId,
        chrome.tabs
          .get(details.tabId)
          .then((tab) => {
            const url = tab.pendingUrl ?? tab.url;
            return url ? mediaIdentity(url) : undefined;
          })
          .catch(() => undefined),
      );
      if (scopes.size > 500) scopes.delete(scopes.keys().next().value!);
      if (details.method !== 'POST') return undefined;
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
      urls: [
        '*://*.googlevideo.com/*',
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.akamaized.net/*',
      ],
    },
    ['requestBody'],
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (
        details.tabId < 0 ||
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
      urls: [
        '*://*.googlevideo.com/*',
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.akamaized.net/*',
      ],
    },
    ['requestHeaders', 'extraHeaders'],
  );
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      captureStats.responses++;
      const headers = requests.get(details.requestId) ?? {};
      requests.delete(details.requestId);
      const sabrRequest = bodies.get(details.requestId);
      bodies.delete(details.requestId);
      const scope = scopes.get(details.requestId);
      scopes.delete(details.requestId);
      const mime =
        details.responseHeaders?.find(
          (h) => h.name.toLowerCase() === 'content-type',
        )?.value ?? '';
      const sabr = !!sabrRequest && mime.includes('yt-ump');
      if (
        details.tabId < 0 ||
        details.initiator?.startsWith('chrome-extension:') ||
        details.statusCode < 200 ||
        details.statusCode >= 300 ||
        (!sabr && !observedAudio(details.url, mime))
      )
        return;
      captureStats.accepted++;
      void chrome.tabs
        .get(details.tabId)
        .then(async (tab) => {
          if (!tab.url) return;
          const identity = mediaIdentity(tab.url);
          if ((await scope) !== identity) return;
          const trackId = sabr
            ? VideoPlaybackAbrRequest.decode(decode64(sabrRequest!))
                .clientAbrState?.audioTrackId || 'default'
            : 'default';
          if (
            session?.candidate.tabId === details.tabId &&
            session.candidate.mediaId === identity &&
            (session.candidate.source?.trackId ?? 'default') !== trackId
          ) {
            await stop();
          }
          const saved = {
            identity,
            source: {
              url: sabr ? details.url : normalizeAudioRequest(details.url),
              mime,
              headers,
              identity,
              trackId,
              ...(sabr ? { sabrRequest } : {}),
            },
          };
          sources.set(details.tabId, saved);
          void chrome.storage.session.set({
            [`source:${details.tabId}`]: saved,
          });
          void chrome.runtime
            .sendMessage({ type: 'sources:updated', tabId: details.tabId })
            .catch(() => {});
        })
        .catch((error) => {
          captureStats.lastError = messageError(error);
        });
    },
    {
      urls: [
        '*://*.googlevideo.com/*',
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.akamaized.net/*',
      ],
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
      urls: [
        '*://*.googlevideo.com/*',
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.akamaized.net/*',
      ],
    },
  );
  const stop = async () => {
    if (session) {
      await chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'engine:stop' })
        .catch(() => {});
      await toPlayer('player:stop');
    }
    session = null;
    await chrome.storage.session.remove('activeSession');
    await cleanRules();
    void chrome.runtime
      .sendMessage({ type: 'session:updated', session: null })
      .catch(() => {});
  };
  chrome.tabs.onRemoved.addListener((id) => {
    sources.delete(id);
    void chrome.storage.session.remove(`source:${id}`);
    if (session?.candidate.tabId === id) void stop();
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.url) {
      const old = sources.get(id);
      if (old && old.identity !== mediaIdentity(change.url)) {
        sources.delete(id);
        void chrome.storage.session.remove(`source:${id}`);
      }
      if (
        session?.candidate.tabId === id &&
        session.candidate.mediaId !== mediaIdentity(change.url)
      )
        void stop();
    }
  });
  chrome.runtime.onMessage.addListener((message: Envelope, sender, respond) => {
    if (
      message.target === 'offscreen' ||
      message.type === 'session:updated' ||
      message.type === 'sources:updated'
    )
      return;
    void (async () => {
      await initialized;
      const privileged = trusted(sender);
      switch (message.type) {
        case 'ui:get':
          // Content scripts can read only this presentation preference.
          return (await loadSettings()).uiLanguage;
        case 'ui:set': {
          if (!privileged) throw new Error('不允许网页修改配置');
          if (message.language !== 'en' && message.language !== 'zh')
            throw new Error('无效的界面语言');
          const next: Settings = {
            ...(await loadSettings()),
            uiLanguage: message.language,
          };
          await chrome.storage.local.set({ settings: next });
          await publishLocale(next.uiLanguage);
          return next.uiLanguage;
        }
        case 'settings:get':
          if (!privileged) throw new Error('不允许网页读取配置');
          return publicSettings(await loadSettings());
        case 'settings:save': {
          if (!privileged) throw new Error('不允许网页修改配置');
          const input = message.settings as Partial<Settings>,
            current = await loadSettings();
          const next = {
            ...current,
            ...input,
            apiKey: input.apiKey?.trim() || current.apiKey,
          };
          endpoint(next);
          if (!/^[a-z]{2,3}$/.test(next.language))
            throw new Error('无效的目标语言');
          if (next.uiLanguage !== 'en' && next.uiLanguage !== 'zh')
            throw new Error('无效的界面语言');
          await chrome.storage.local.set({ settings: next });
          if (next.uiLanguage !== current.uiLanguage)
            await publishLocale(next.uiLanguage);
          return publicSettings(next);
        }
        case 'settings:forget': {
          if (!privileged) throw new Error('不允许网页修改配置');
          await stop();
          const current = await loadSettings();
          const next = {
            ...DEFAULT_SETTINGS,
            language: current.language,
            uiLanguage: current.uiLanguage,
          };
          await chrome.storage.local.set({ settings: next });
          return publicSettings(next);
        }
        case 'settings:test':
          if (!privileged) throw new Error('不允许网页测试凭据');
          if (session) throw new Error('请先停止翻译再测试连接');
          await ensureOffscreen();
          return chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'engine:probe',
            settings: await loadSettings(),
          });
        case 'media:discover':
          if (!privileged) throw new Error('不允许网页触发扫描');
          return discover(Number(message.tabId));
        case 'media:refresh': {
          if (
            !privileged ||
            !session ||
            session.id !== message.sessionId ||
            session.epoch !== message.epoch
          )
            throw new Error('翻译任务已过期');
          const fresh = sources.get(session.candidate.tabId);
          if (fresh?.identity === session.candidate.mediaId)
            return {
              ...session.candidate.source,
              ...fresh.source,
              sabrFormats: session.candidate.source?.sabrFormats,
            };
          return session.candidate.source;
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
          await stop();
          const choice = message.candidate as MediaCandidate;
          const fresh = (await discover(choice.tabId)).find(
            (v) => v.id === choice.id && v.frameId === choice.frameId,
          );
          if (!fresh) throw new Error('视频已变化，请重新扫描');
          if (fresh.ad) throw new Error('请等待广告结束，再选择正片');
          if (!fresh.duration) throw new Error('首版仅支持普通点播视频');
          if (!fresh.source)
            throw new Error(
              '尚未发现可预取的音轨。请先播放几秒，再重新扫描；本版本不会以滞后采集代替同步。',
            );
          const settings = await loadSettings();
          endpoint(settings);
          if (!settings.apiKey) throw new Error('请先在设置中填写百炼凭据');
          session = {
            id: crypto.randomUUID(),
            epoch: 0,
            candidate: fresh,
            language: String(message.language ?? settings.language),
            phase: 'preparing',
            position: fresh.currentTime,
            rate: 1,
            readyThrough: fresh.currentTime,
            inputThrough: fresh.currentTime,
            skipped: 0,
            originalVolume: 0,
            dubVolume: 1,
            subtitles: true,
            segments: [],
          };
          const attached = await toPlayer('player:attach', { session });
          if (!attached?.ok) {
            session = null;
            throw new Error('播放器已被页面替换，请重新扫描');
          }
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'engine:start',
            session,
            settings,
          });
          if (result?.ok === false) {
            await stop();
            throw new Error(result.error);
          }
          return session;
        }
        case 'session:stop':
          if (!privileged) throw new Error('不允许网页停止翻译');
          await stop();
          return true;
        case 'session:mix':
          if (!privileged || !session) return false;
          session.originalVolume = Math.max(
            0,
            Math.min(1, Number(message.originalVolume)),
          );
          session.dubVolume = Math.max(
            0,
            Math.min(1, Number(message.dubVolume)),
          );
          session.subtitles = Boolean(message.subtitles);
          await chrome.storage.session.set({ activeSession: session });
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'engine:mix',
            sessionId: session.id,
            originalVolume: session.originalVolume,
            dubVolume: session.dubVolume,
            subtitles: session.subtitles,
          });
          await toPlayer('player:mix', {
            originalVolume: session.originalVolume,
            dubVolume: session.dubVolume,
            subtitles: session.subtitles,
          });
          return true;
        case 'auth:install':
          if (!privileged) throw new Error('不允许网页安装鉴权规则');
          if (
            message.sessionId &&
            (session?.id !== message.sessionId ||
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
          const source = message.source as AudioSource;
          if (!safeMediaUrl(source.url))
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
            await chrome.storage.session.set({ activeSession: session });
            if (session.phase === 'error') await cleanRules();
            await toPlayer('player:state', { session });
            void chrome.runtime
              .sendMessage({ type: 'session:updated', session })
              .catch(() => {});
          }
          return true;
        case 'engine:segment':
          if (!privileged || session?.id !== message.sessionId) return false;
          await toPlayer('player:segment', {
            segment: message.segment,
            epoch: message.epoch,
          });
          return true;
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
            await stop();
            return true;
          }
          return chrome.runtime.sendMessage({
            ...message,
            target: 'offscreen',
          });
        case 'cache:clear':
          if (!privileged) throw new Error('不允许网页清理缓存');
          if (session) throw new Error('请先停止翻译，再清理缓存');
          await ensureOffscreen();
          return chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'cache:clear',
          });
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
