import { endpoint, publicSettings } from '../../security';
import { DEFAULT_SETTINGS, LANGUAGES, type Settings } from '../../types';
import { stopSession } from '../session';
import type { RouteGroup } from '../router';

const WRITE = '不允许网页修改配置';
export const isUILanguage = (value: unknown): value is Settings['uiLanguage'] =>
  value === 'en' || value === 'zh';
export const isTargetLanguage = (value: unknown) => LANGUAGES.some(([code]) => code === value);

export const settingsRoutes: RouteGroup<
  'ui:get' | 'ui:set' | 'settings:get' | 'settings:save' | 'settings:forget' | 'settings:test'
> = {
  // Content scripts can read only this presentation preference.
  'ui:get': { handle: async ({ ctx }) => (await ctx.loadSettings()).uiLanguage },
  'ui:set': {
    privileged: WRITE,
    handle: ({ ctx, message }) => {
      const language = message.language;
      if (!isUILanguage(language)) throw new Error('无效的界面语言');
      return ctx.transitions.run(async () => {
        const next: Settings = { ...(await ctx.loadSettings()), uiLanguage: language };
        await chrome.storage.local.set({ settings: next });
        await ctx.publishLocale(next.uiLanguage);
        return next.uiLanguage;
      });
    },
  },
  'settings:get': {
    privileged: '不允许网页读取配置',
    handle: async ({ ctx }) => publicSettings(await ctx.loadSettings()),
  },
  'settings:save': {
    privileged: WRITE,
    handle: ({ ctx, message }) =>
      ctx.transitions.run(async () => {
        const input = message.settings,
          current = await ctx.loadSettings();
        const next = {
          ...current,
          ...input,
          apiKey: input.apiKey?.trim() || current.apiKey,
          autoSaveFiles:
            input.autoSaveFiles === undefined ? current.autoSaveFiles : input.autoSaveFiles === true,
        };
        endpoint(next);
        if (
          ctx.observedTaskTab() !== undefined &&
          (next.apiKey !== current.apiKey ||
            next.workspace !== current.workspace ||
            next.region !== current.region)
        )
          throw new Error('请先停止翻译，再修改服务凭据');
        if (!isTargetLanguage(next.language)) throw new Error('无效的目标语言');
        if (!isUILanguage(next.uiLanguage)) throw new Error('无效的界面语言');
        await chrome.storage.local.set({ settings: next });
        if (next.uiLanguage !== current.uiLanguage) await ctx.publishLocale(next.uiLanguage);
        return publicSettings(next);
      }),
  },
  'settings:forget': {
    privileged: WRITE,
    handle: ({ ctx }) => {
      const stopping = stopSession(ctx);
      return ctx.transitions.run(async () => {
        await stopping;
        const current = await ctx.loadSettings();
        const next = {
          ...DEFAULT_SETTINGS,
          language: current.language,
          uiLanguage: current.uiLanguage,
          autoSaveFiles: current.autoSaveFiles,
        };
        await chrome.storage.local.set({ settings: next });
        return publicSettings(next);
      });
    },
  },
  'settings:test': {
    privileged: '不允许网页测试凭据',
    handle: ({ ctx }) =>
      ctx.transitions.run(async () => {
        if (ctx.session) throw new Error('请先停止翻译再测试连接');
        await ctx.ensureOffscreen();
        const settings = await ctx.loadSettings();
        if (ctx.session) throw new Error('请先停止翻译再测试连接');
        return ctx.toOffscreen('engine:probe', { settings });
      }),
  },
};
