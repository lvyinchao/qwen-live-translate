import { mediaIdentity } from '../lib/adapters';
import { BackgroundContext } from '../lib/background/context';
import { fileRoutes } from '../lib/background/handlers/files';
import { mediaRoutes } from '../lib/background/handlers/media';
import { sessionRoutes } from '../lib/background/handlers/session';
import { settingsRoutes } from '../lib/background/handlers/settings';
import { dispatch, type Routes } from '../lib/background/router';
import { stopSession } from '../lib/background/session';
import { captionPreferences } from '../lib/captions';
import { errorCode } from '../lib/errors';
import { t } from '../lib/i18n';
import { candidatePageId } from '../lib/media-identity';
import { registerMediaObserver } from '../lib/media-observer';
import { BROADCASTS, type BackgroundMessage } from '../lib/messages';
import { messageError, type PlaybackSession, type Settings } from '../lib/types';

const routes: Routes = { ...fileRoutes, ...settingsRoutes, ...mediaRoutes, ...sessionRoutes };
const PANEL_PORT = 'timbradub-panel';

export default defineBackground(() => {
  const ctx = new BackgroundContext();
  const stop = (expectedId?: string) => stopSession(ctx, expectedId);

  const initialize = async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.action.setTitle({
      title: t((await ctx.loadSettings()).uiLanguage, '打开听译 · 原音色视频翻译'),
    });
    const saved = (await chrome.storage.session.get('activeSession')).activeSession as
      PlaybackSession | undefined;
    if (saved && (await ctx.hasOffscreen())) {
      ctx.session = { ...saved, ...captionPreferences(saved) };
      await ctx.rules.restore();
    } else {
      await ctx.rules.clear();
      await chrome.storage.session.remove('activeSession');
    }
    // Observation leases do not survive worker shutdown. Do not revive signed
    // media URLs collected by an old panel or an unrelated page.
    await ctx.pruneObservations();
  };
  const initialized = initialize();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const autoSave = (value: unknown) =>
      (value as Partial<Settings> | undefined)?.autoSaveFiles === true;
    if (autoSave(changes.settings.oldValue) === autoSave(changes.settings.newValue)) return;
    void (async () => {
      if (await ctx.hasOffscreen()) await ctx.toOffscreen('files:configure');
    })().catch(() => {});
  });

  registerMediaObserver({
    scope: ctx.observation,
    sources: ctx.sources,
    detected: ctx.detected,
    captureStats: ctx.captureStats,
    getSession: () => (ctx.observedTaskTab() !== undefined ? ctx.session : null),
    stop: () => stop(),
  });

  /** Ends a panel's observation of `tabId` unless another panel or the task needs it. */
  const releaseUnless = (tabId: number | undefined) => {
    if (tabId !== undefined && !ctx.panelWatches(tabId) && ctx.observedTaskTab() !== tabId)
      ctx.releaseObservation(tabId);
  };
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT || !port.sender || !ctx.trusted(port.sender)) return;
    const watch: { tabId?: number; windowId?: number } = {};
    ctx.panels.set(port, watch);
    port.onMessage.addListener((message) => {
      if (message.type !== 'watch' || !Number.isInteger(message.tabId)) return;
      if (
        watch.tabId !== undefined &&
        watch.tabId !== message.tabId &&
        ctx.observedTaskTab() !== watch.tabId
      )
        ctx.releaseObservation(watch.tabId);
      watch.tabId = message.tabId;
      watch.windowId = message.windowId;
      ctx.observation.watch(message.tabId);
    });
    port.onDisconnect.addListener(() => {
      ctx.panels.delete(port);
      releaseUnless(watch.tabId);
    });
  });
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    for (const watch of ctx.panels.values())
      if (watch.windowId === undefined || watch.windowId === windowId) {
        if (
          watch.tabId !== undefined &&
          watch.tabId !== tabId &&
          ctx.observedTaskTab() !== watch.tabId
        )
          ctx.releaseObservation(watch.tabId);
        watch.tabId = tabId;
        ctx.observation.watch(tabId);
      }
  });
  chrome.tabs.onRemoved.addListener((id) => {
    ctx.releaseObservation(id);
    if (ctx.session?.candidate.tabId === id) void stop();
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === 'loading') {
      // A same-URL reload is a new document too: its old pending metadata may
      // not repopulate discovery merely because the GUID remains unchanged.
      ctx.observation.invalidate(id);
      ctx.cctvSources.delete(id);
    }
    if (!change.url) return;
    ctx.observation.invalidate(id);
    const page = mediaIdentity(change.url);
    if (ctx.detected.get(id)?.identity !== page) {
      ctx.detected.delete(id);
      void chrome.storage.session.remove(`detected:${id}`);
    }
    const old = ctx.sources.get(id);
    if (old && old.identity !== page) {
      ctx.sources.delete(id);
      void chrome.storage.session.remove(`source:${id}`);
    }
    if (ctx.session?.candidate.tabId === id && candidatePageId(ctx.session.candidate) !== page)
      void stop();
  });

  chrome.runtime.onMessage.addListener(
    (message: BackgroundMessage | { target?: string; type: string }, sender, respond) => {
      if (
        message.target === 'offscreen' ||
        (BROADCASTS as readonly string[]).includes(message.type)
      )
        return;
      void (async () => {
        await initialized;
        return dispatch(routes, ctx, message as BackgroundMessage, sender);
      })().then(
        (value) => respond({ ok: true, value }),
        (error) => respond({ ok: false, error: messageError(error), code: errorCode(error) }),
      );
      return true;
    },
  );
});
