import { SessionTransitions } from '../async-lifecycle';
import type { CctvMedia } from '../cctv-media';
import { normalizeUILanguage, t } from '../i18n';
import type { DiscoveryRecord, SourceRecord } from '../media-observer';
import { ObservationScope } from '../observation-scope';
import { SessionRules } from './rules';
import { DEFAULT_SETTINGS, type PlaybackSession, type Settings, type UILanguage } from '../types';

export interface PanelWatch {
  tabId?: number;
  windowId?: number;
}
export interface CctvLookup {
  identity: string;
  guid: string;
  expiresAt: number;
  value: Promise<CctvMedia | undefined>;
}

const OFFSCREEN = () => ({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
const ENDED_PHASES = ['error', 'ended'];
export const isFinished = (session: PlaybackSession) => ENDED_PHASES.includes(session.phase);

/** All mutable service-worker state. One instance lives per worker lifetime. */
export class BackgroundContext {
  readonly sources = new Map<number, SourceRecord>();
  readonly detected = new Map<number, DiscoveryRecord>();
  readonly cctvSources = new Map<number, CctvLookup>();
  readonly observation = new ObservationScope();
  readonly panels = new Map<chrome.runtime.Port, PanelWatch>();
  readonly captureStats = { responses: 0, accepted: 0, lastError: '' };
  readonly transitions = new SessionTransitions();
  readonly rules = new SessionRules();
  session: PlaybackSession | null = null;
  languageRequest = 0;
  private offscreenCreating: Promise<void> | undefined;

  /** The tab a running task keeps observed after its panel lease ends. */
  observedTaskTab(): number | undefined {
    const session = this.session;
    return session && !isFinished(session) ? session.candidate.tabId : undefined;
  }
  panelWatches(tabId: number) {
    return [...this.panels.values()].some((panel) => panel.tabId === tabId);
  }
  trusted(sender: chrome.runtime.MessageSender) {
    return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
  }

  releaseObservation(tabId: number) {
    this.observation.release(tabId);
    this.sources.delete(tabId);
    this.detected.delete(tabId);
    this.cctvSources.delete(tabId);
    void chrome.storage.session.remove([`source:${tabId}`, `detected:${tabId}`]);
  }
  async pruneObservations() {
    for (const id of this.observation.expired())
      if (this.observedTaskTab() !== id) this.releaseObservation(id);
    const now = Date.now();
    const persisted = await chrome.storage.session.get(null);
    const expired = Object.entries(persisted)
      .filter(([key, value]) => {
        if (!/^(?:source|detected):\d+$/.test(key)) return false;
        const tabId = Number(key.split(':')[1]);
        const record = value as SourceRecord | DiscoveryRecord;
        return (
          !this.observation.allows(tabId, this.observedTaskTab()) ||
          !record.expiresAt ||
          record.expiresAt <= now
        );
      })
      .map(([key]) => key);
    for (const key of expired) {
      const id = Number(key.split(':')[1]);
      (key.startsWith('source:') ? this.sources : this.detected).delete(id);
    }
    if (expired.length) await chrome.storage.session.remove(expired);
  }

  async hasOffscreen() {
    return (await chrome.runtime.getContexts(OFFSCREEN())).length > 0;
  }
  async ensureOffscreen() {
    const existing = await this.hasOffscreen();
    // Chrome exposes a newly created context before its scripts finish loading.
    // Concurrent callers must share the pending creation before trusting it.
    if (this.offscreenCreating) return this.offscreenCreating;
    if (existing) return;
    this.offscreenCreating ??= chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
        justification:
          'Decode media audio in a worker and maintain bounded Blob caches for the active translation task',
      })
      .finally(() => {
        this.offscreenCreating = undefined;
      });
    await this.offscreenCreating;
  }
  /** Sends to the offscreen document; replies use the offscreen `Result` shape. */
  toOffscreen<T = unknown>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  }

  async loadSettings(): Promise<Settings> {
    const saved = (await chrome.storage.local.get('settings')).settings as
      Partial<Settings> | undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      uiLanguage: normalizeUILanguage(saved?.uiLanguage),
      autoSaveFiles: saved?.autoSaveFiles === true,
    };
  }
  async publishLocale(language: UILanguage) {
    await chrome.action.setTitle({ title: t(language, '打开听译 · 原音色视频翻译') });
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) => chrome.tabs.sendMessage(tab.id!, { type: 'ui:changed', language })),
    );
  }
}
