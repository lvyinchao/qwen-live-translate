import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { mediaIdentity, observedAudio } from '../../adapters';
import { decode64 } from '../../audio';
import { AppError } from '../../errors';
import { candidatePageId } from '../../media-identity';
import { OBSERVATION_TTL_MS } from '../../media-observer';
import { safeMediaUrl } from '../../security';
import { parseTencentMedia } from '../../tencent-media';
import { discover } from '../discover';
import { isCurrentRevision } from '../session';
import type { RouteGroup } from '../router';

const TENCENT_PAGE = 'https://v.qq.com/';
const PLAYER_ID = /^[a-zA-Z0-9-]{1,64}$/;
const expired = () => new AppError('session-expired', '翻译任务已过期');

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

export const mediaRoutes: RouteGroup<
  | 'media:tencent-info'
  | 'media:discover'
  | 'media:refresh'
  | 'media:diagnostics'
  | 'media:highlight'
  | 'media:headers'
> = {
  'media:tencent-info': {
    // Sent by the isolated Tencent bridge, never by an extension page.
    handle: async ({ ctx, message, sender }) => {
      const tabId = sender.tab?.id;
      if (!tabId || !sender.url?.startsWith(TENCENT_PAGE))
        throw new AppError('forbidden', '不允许网页触发扫描');
      if (!ctx.observation.allows(tabId, ctx.observedTaskTab())) return false;
      const observedRevision = ctx.observation.revision(tabId);
      const stillObserved = () =>
        ctx.observation.allows(tabId, ctx.observedTaskTab()) &&
        ctx.observation.revision(tabId) === observedRevision;
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !stillObserved()) return false;
      const supplied = message.media ?? {};
      const validated = parseTencentMedia(
        JSON.stringify({
          vinfo: {
            vl: {
              vi: [
                {
                  vid: supplied.videoId,
                  drm: supplied.protected ? 1 : 0,
                  ul: { m3u8: supplied.playlist, ui: [{ url: supplied.url }] },
                },
              ],
            },
          },
        }),
        tab.url,
      );
      if (!validated) return false;
      const identity = mediaIdentity(tab.url);
      const previous = ctx.detected.get(tabId);
      const items = previous?.identity === identity ? previous.items : [];
      const frameId = sender.frameId ?? 0;
      const state = {
        identity,
        expiresAt: Date.now() + OBSERVATION_TTL_MS,
        items: [
          ...items.filter(
            (r) => r.kind !== 'hls' || r.frameId !== frameId || r.playerId !== supplied.playerId,
          ),
          {
            url: validated.url,
            mime: 'application/vnd.apple.mpegurl',
            kind: 'hls' as const,
            hlsManifest: validated.playlist,
            protected: validated.protected,
            playerId:
              typeof supplied.playerId === 'string' && PLAYER_ID.test(supplied.playerId)
                ? supplied.playerId
                : undefined,
            frameId,
            at: Date.now(),
            headers: { Referer: tab.url, Origin: 'https://v.qq.com' },
          },
        ],
      };
      if (!stillObserved()) return false;
      ctx.detected.set(tabId, state);
      await chrome.storage.session.set({ [`detected:${tabId}`]: state });
      if (!stillObserved()) {
        if (!ctx.detected.has(tabId) || ctx.detected.get(tabId) === state) {
          ctx.detected.delete(tabId);
          await chrome.storage.session.remove(`detected:${tabId}`);
        }
        return false;
      }
      void chrome.runtime.sendMessage({ type: 'sources:updated', tabId }).catch(() => {});
      return true;
    },
  },
  'media:discover': {
    privileged: '不允许网页触发扫描',
    handle: ({ ctx, message }) => discover(ctx, Number(message.tabId)),
  },
  'media:refresh': {
    handle: async ({ ctx, message, sender }) => {
      const session = ctx.session;
      if (!ctx.trusted(sender) || !isCurrentRevision(session, message)) throw expired();
      const fresh = ctx.sources.get(session.candidate.tabId);
      if (
        fresh?.expiresAt &&
        fresh.expiresAt > Date.now() &&
        fresh.identity === candidatePageId(session.candidate) &&
        (fresh.source.sabrRequest || observedAudio(fresh.source.url, fresh.source.mime ?? ''))
      )
        return {
          ...session.candidate.source,
          ...fresh.source,
          sabrFormats: session.candidate.source?.sabrFormats,
        };
      const owner = session;
      if (owner.candidate.site !== 'youtube' && owner.candidate.site !== 'bilibili') {
        const candidates = await discover(ctx, owner.candidate.tabId);
        if (
          ctx.session?.id !== owner.id ||
          ctx.session.epoch !== owner.epoch ||
          ctx.session.languageVersion !== owner.languageVersion
        )
          throw expired();
        const current = candidates.find(
          (c) => c.id === owner.candidate.id && c.frameId === owner.candidate.frameId,
        );
        if (current?.source && current.mediaId === owner.candidate.mediaId) return current.source;
        if (current?.source) throw new Error('视频或音轨已变化，请重新扫描');
      }
      return owner.candidate.source;
    },
  },
  'media:diagnostics': {
    privileged: '不允许网页读取诊断',
    handle: ({ ctx }) => ({
      ...ctx.captureStats,
      sources: [...ctx.sources].map(([tabId, value]) => ({
        tabId,
        identity: value.identity,
        host: hostOf(value.source.url),
        sabr: Boolean(value.source.sabrRequest),
        poTokenBytes: value.source.sabrRequest
          ? (VideoPlaybackAbrRequest.decode(decode64(value.source.sabrRequest)).streamerContext
              ?.poToken?.length ?? 0)
          : undefined,
      })),
    }),
  },
  'media:highlight': {
    privileged: '不允许网页触发选择',
    handle: async ({ message }) => {
      await chrome.tabs.sendMessage(
        Number(message.tabId),
        { type: 'player:highlight', id: message.id },
        { frameId: Number(message.frameId) },
      );
      return true;
    },
  },
  'media:headers': {
    privileged: '不允许网页修改请求规则',
    handle: async ({ ctx, message }) => {
      if (message.sessionId && !isCurrentRevision(ctx.session, message)) throw expired();
      const source = message.source;
      if (!safeMediaUrl(source.url, true)) throw new Error('媒体域名不在允许范围');
      if (!Object.keys(source.headers ?? {}).length) return true;
      await ctx.rules.setMediaHeaders(source);
      return true;
    },
  },
};
