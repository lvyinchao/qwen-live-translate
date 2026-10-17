import { captionPreferences, mergeCaptionPreferences } from '../../captions';
import { AppError } from '../../errors';
import { endpoint } from '../../security';
import { acceptEngineState } from '../../session';
import type { PlaybackSession, Result } from '../../types';
import { discover } from '../discover';
import { isFinished } from '../context';
import { forwardTerminals, isCurrentRevision, stopOwned, stopSession, toPlayer } from '../session';
import { isTargetLanguage } from './settings';
import type { Route, RouteGroup } from '../router';

const TRANSLATE = '不允许网页触发翻译';
const START_FAILED = '翻译启动失败，请重试';
const PLAYER_REPLACED = '播放器已被页面替换，请重新扫描';
const expired = () => new AppError('session-expired', '翻译任务已过期');
const clamp = (value: unknown, previous: number) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : previous;

type PlayerType = 'player:clock' | 'player:seek' | 'player:lost' | 'player:skip' | 'player:metric';
/** Reports from the session's own player frame are relayed to the engine. */
function playerRoute<K extends PlayerType>(): Route<K> {
  return {
    handle: async ({ ctx, message, sender }) => {
      const session = ctx.session;
      if (
        !session ||
        sender.tab?.id !== session.candidate.tabId ||
        sender.frameId !== session.candidate.frameId ||
        message.sessionId !== session.id
      )
        return false;
      if (message.type === 'player:lost') {
        await forwardTerminals(session, message.terminals).catch(() => {});
        await stopSession(ctx);
        return true;
      }
      return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    },
  };
}

export const sessionRoutes: RouteGroup<
  | 'session:get'
  | 'session:diagnostics'
  | 'session:start'
  | 'session:language'
  | 'session:stop'
  | 'session:mix'
  | 'auth:install'
  | 'auth:remove'
  | 'engine:state'
  | 'engine:segment'
  | PlayerType
> = {
  'session:get': { privileged: { fallback: null }, handle: ({ ctx }) => ctx.session },
  'session:diagnostics': {
    privileged: '不允许网页读取诊断',
    handle: async ({ ctx }) => {
      await ctx.ensureOffscreen();
      return ctx.toOffscreen('engine:diagnostics');
    },
  },
  'session:start': {
    privileged: TRANSLATE,
    handle: ({ ctx, message }) => {
      const { transitions } = ctx;
      const ticket = transitions.invalidate();
      ctx.languageRequest++;
      return transitions.run(async () => {
        if (!transitions.current(ticket)) return ctx.session;
        await stopOwned(ctx, ctx.session);
        if (!transitions.current(ticket)) return ctx.session;
        const choice = message.candidate;
        const fresh = (await discover(ctx, choice.tabId)).find(
          (v) => v.id === choice.id && v.frameId === choice.frameId,
        );
        if (!transitions.current(ticket)) return ctx.session;
        if (!fresh) throw new Error('视频已变化，请重新扫描');
        if (fresh.sourceReason && !fresh.source) throw new Error(fresh.sourceReason);
        if (fresh.ad) throw new Error('请等待广告结束，再选择正片');
        if (!fresh.duration) throw new Error('首版仅支持普通点播视频');
        if (!fresh.source)
          throw new Error(
            '尚未发现可预取的音轨。请先播放几秒，再重新扫描；本版本不会以滞后采集代替同步。',
          );
        const settings = await ctx.loadSettings();
        endpoint(settings);
        if (!settings.apiKey) throw new Error('请先在设置中填写百炼凭据');
        const language = String(message.language ?? settings.language);
        if (!isTargetLanguage(language)) throw new Error('无效的目标语言');
        if (!transitions.current(ticket)) return ctx.session;
        const owner: PlaybackSession = {
          id: crypto.randomUUID(),
          epoch: 0,
          languageVersion: 0,
          candidate: fresh,
          language,
          phase: 'preparing',
          position: fresh.currentTime,
          rate: fresh.playbackRate ?? 1,
          readyThrough: fresh.currentTime,
          inputThrough: fresh.currentTime,
          skipped: 0,
          originalVolume: 0,
          dubVolume: 1,
          ...captionPreferences(),
          segments: [],
        };
        ctx.session = owner;
        try {
          const attached = await toPlayer(ctx, 'player:attach', { session: owner }, owner);
          if (!attached?.ok) throw new Error(PLAYER_REPLACED);
          if (Number.isFinite(attached.rate) && attached.rate > 0) owner.rate = attached.rate;
          if (Number.isFinite(attached.position)) {
            owner.position = attached.position;
            owner.readyThrough = owner.inputThrough = attached.position;
          }
          if (!transitions.current(ticket)) {
            await stopOwned(ctx, owner);
            return ctx.session;
          }
          await ctx.ensureOffscreen();
          if (!transitions.current(ticket)) {
            await stopOwned(ctx, owner);
            return ctx.session;
          }
          const result = await ctx.toOffscreen<Result<unknown> | undefined>('engine:start', {
            session: owner,
            settings,
          });
          if (result?.ok !== true) throw new Error(result?.error ?? START_FAILED);
          if (!transitions.current(ticket)) {
            await stopOwned(ctx, owner);
            return ctx.session;
          }
          return ctx.session;
        } catch (error) {
          await stopOwned(ctx, owner).catch(() => {});
          throw error;
        }
      });
    },
  },
  'session:language': {
    privileged: TRANSLATE,
    handle: ({ ctx, message }) => {
      const request = ++ctx.languageRequest;
      return ctx.transitions.run(async () => {
        if (request !== ctx.languageRequest) return ctx.session;
        const language = String(message.language);
        if (!isTargetLanguage(language)) throw new Error('无效的目标语言');
        const session = ctx.session;
        if (!session || session.id !== message.sessionId) throw expired();
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
        ctx.session = next;
        try {
          const clock = await toPlayer(ctx, 'player:language', { session: next }, next);
          if (ctx.session !== next) return ctx.session;
          if (!clock?.ok) {
            await stopOwned(ctx, next);
            throw new Error(PLAYER_REPLACED);
          }
          next.position = clock.position;
          next.rate = clock.rate;
          next.readyThrough = next.inputThrough = clock.position;
          await chrome.storage.session.set({ activeSession: next });
          if (ctx.session !== next) return ctx.session;
          void chrome.runtime
            .sendMessage({ type: 'session:updated', session: next })
            .catch(() => {});
          const result = await ctx.toOffscreen<Result<unknown> | undefined>('engine:language', {
            session: next,
            userPaused: clock.userPaused,
          });
          const current = ctx.session as PlaybackSession | null;
          if (
            current?.id !== next.id ||
            current.epoch !== next.epoch ||
            current.language !== language
          )
            return current;
          if (result?.ok !== true) {
            await stopOwned(ctx, next);
            throw new Error(result?.error ?? START_FAILED);
          }
          return current;
        } catch (error) {
          if (ctx.session?.id === next.id) await stopOwned(ctx, next).catch(() => {});
          throw error;
        }
      });
    },
  },
  'session:stop': {
    privileged: '不允许网页停止翻译',
    handle: async ({ ctx }) => {
      await stopSession(ctx);
      return true;
    },
  },
  'session:mix': {
    privileged: { fallback: false },
    handle: async ({ ctx, message }) => {
      const owner = ctx.session;
      if (
        !owner ||
        (message.sessionId && message.sessionId !== owner.id) ||
        (message.languageVersion !== undefined &&
          message.languageVersion !== (owner.languageVersion ?? 0))
      )
        return false;
      owner.originalVolume = clamp(message.originalVolume, owner.originalVolume);
      owner.dubVolume = clamp(message.dubVolume, owner.dubVolume);
      Object.assign(owner, mergeCaptionPreferences(owner, message));
      await chrome.storage.session.set({ activeSession: owner });
      const changes = {
        sessionId: owner.id,
        languageVersion: owner.languageVersion ?? 0,
        originalVolume: owner.originalVolume,
        dubVolume: owner.dubVolume,
        ...captionPreferences(owner),
      };
      await ctx.toOffscreen('engine:mix', changes);
      if (ctx.session?.id === owner.id) await toPlayer(ctx, 'player:mix', changes, owner);
      return true;
    },
  },
  'auth:install': {
    privileged: '不允许网页安装鉴权规则',
    handle: async ({ ctx, message }) => {
      if (message.sessionId && !isCurrentRevision(ctx.session, message)) throw expired();
      await ctx.rules.installAuth(await ctx.loadSettings());
      return endpoint(await ctx.loadSettings());
    },
  },
  'auth:remove': {
    privileged: '不允许网页修改鉴权规则',
    handle: async ({ ctx }) => {
      await ctx.rules.removeAuth();
      return true;
    },
  },
  'engine:state': {
    privileged: { fallback: false },
    handle: async ({ ctx, message }) => {
      const accepted = acceptEngineState(ctx.session, message.session);
      if (!accepted) return true;
      ctx.session = accepted;
      if (isFinished(accepted) && !ctx.panelWatches(accepted.candidate.tabId))
        ctx.releaseObservation(accepted.candidate.tabId);
      await chrome.storage.session.set({ activeSession: accepted });
      if (ctx.session !== accepted) return false;
      if (isFinished(accepted)) {
        // Rule cleanup is serialized with starts; an old error cannot
        // remove the next task's authentication or media headers.
        void ctx.transitions.run(async () => {
          if (ctx.session === accepted) await ctx.rules.clear();
        });
      }
      await toPlayer(ctx, 'player:state', { session: accepted }, accepted);
      if (ctx.session === accepted)
        void chrome.runtime
          .sendMessage({ type: 'session:updated', session: accepted })
          .catch(() => {});
      return true;
    },
  },
  'engine:segment': {
    privileged: { fallback: false },
    handle: async ({ ctx, message }) => {
      const owner = ctx.session;
      if (
        !isCurrentRevision(owner, message) ||
        (message.segment as { language?: string } | undefined)?.language !== owner.language
      )
        return false;
      const delivered = await toPlayer(
        ctx,
        'player:segment',
        {
          segment: message.segment,
          epoch: message.epoch,
          languageVersion: message.languageVersion,
        },
        owner,
      );
      return delivered?.ok === true;
    },
  },
  'player:clock': playerRoute(),
  'player:seek': playerRoute(),
  'player:lost': playerRoute(),
  'player:skip': playerRoute(),
  'player:metric': playerRoute(),
};
