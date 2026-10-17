import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  ArrowRight,
  Check,
  CircleHelp,
  Headphones,
  KeyRound,
  Languages,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Square,
} from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  type MediaCandidate,
  type PlaybackSession,
  type Settings,
} from '../../lib/types';
import { languageName, localizeMessage, normalizeUILanguage, t as translate } from '../../lib/i18n';
import type { UILanguage } from '../../lib/types';
import { EMPTY_FILE_STATUS, type LocalFileStatus } from '../../lib/archive';
import { isOlderStateVersion } from '../../lib/session';
import { captionPreferences, mergeCaptionPreferences } from '../../lib/captions';

import { call, type PublicSettings } from './api';
import type { Broadcast } from '../../lib/messages';
import { phaseNames, candidateKey, translator } from './ui';
import { ProviderNotice } from './components/ProviderNotice';
import { SettingsView } from './components/SettingsView';
import { VideoList } from './components/VideoList';
import { PlaybackView, type MixChanges } from './components/PlaybackView';
import { LocalFilesView } from './components/LocalFilesView';
import { usePanelWatch } from './use-panel-watch';

/** Fallback rescan interval; also renews the 15-second observation lease. */
const POLL_MS = 3000;

export function App() {
  const [view, setView] = useState<'videos' | 'settings'>('videos');
  const [settings, setSettings] = useState<PublicSettings>({
    ...DEFAULT_SETTINGS,
    hasKey: false,
  });
  const locale = settings.uiLanguage;
  const t = translator(locale);
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [language, setLanguage] = useState('zh');
  const [videos, setVideos] = useState<MediaCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [files, setFiles] = useState<LocalFileStatus>(EMPTY_FILE_STATUS);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const watch = usePanelWatch();
  const sessionUpdates = useRef(0);
  const languageRequest = useRef(0);
  const languagePending = useRef(false);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const receiveSession = (next: PlaybackSession | null) => {
    const current = sessionRef.current;
    if (
      next &&
      current?.id === next.id &&
      ((next.languageVersion ?? 0) < (current.languageVersion ?? 0) ||
        isOlderStateVersion(current, next) ||
        ((next.languageVersion ?? 0) === (current.languageVersion ?? 0) &&
          next.epoch < current.epoch))
    )
      return;
    sessionUpdates.current++;
    const normalized = next ? { ...next, ...captionPreferences(next) } : null;
    sessionRef.current = normalized;
    setSession(normalized);
    if (next && !languagePending.current) setLanguage(next.language);
  };
  const changeLanguage = async (value: string) => {
    setLanguage(value);
    const current = sessionRef.current;
    if (!current) return;
    const request = ++languageRequest.current;
    languagePending.current = true;
    setError('');
    try {
      const next = await call('session:language', {
        sessionId: current.id,
        language: value,
      });
      if (request !== languageRequest.current || !mounted.current) return;
      languagePending.current = false;
      receiveSession(next);
    } catch (e) {
      if (request !== languageRequest.current || !mounted.current) return;
      languagePending.current = false;
      setError(e instanceof Error ? e.message : '操作未完成，请重试');
      try {
        const active = await call('session:get');
        if (request === languageRequest.current && mounted.current) receiveSession(active);
      } catch {
        /* Keep the actionable language error if state recovery also fails. */
      }
    }
  };
  const scanning = useRef(false);
  const lastScan = useRef(0);
  const mounted = useRef(true);
  const scan = async () => {
    if (scanning.current) return;
    scanning.current = true;
    lastScan.current = Date.now();
    try {
      const [current] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!mounted.current) return;
      watch(current);
      if (!current?.id || !current.url || !/^https?:\/\//.test(current.url)) {
        setVideos([]);
        return;
      }
      const items = await call('media:discover', {
        tabId: current.id,
      });
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!mounted.current || active?.id !== current.id || active?.url !== current.url) return;
      items.sort((a, b) => b.width * b.height - a.width * a.height);
      setVideos(items);
      setSelected((old) =>
        items.some((v) => candidateKey(v) === old) ? old : items[0] ? candidateKey(items[0]) : '',
      );
    } finally {
      scanning.current = false;
    }
  };
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成，请重试');
    } finally {
      setBusy('');
    }
  };
  useEffect(() => {
    mounted.current = true;
    void call('settings:get')
      .then((s) => {
        setSettings(s);
        if (!sessionRef.current && !languagePending.current) setLanguage(s.language);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
    const hydration = sessionUpdates.current;
    void call('session:get')
      .then((next) => {
        if (mounted.current && sessionUpdates.current === hydration) receiveSession(next);
      })
      .catch((error) => {
        if (mounted.current) setError(error.message);
      });
    void call('files:status')
      .then(setFiles)
      .catch((e) => setFiles((old) => ({ ...old, error: e.message })));
    void scan().catch((e) => setError(e.message));
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    const listener = (m: Broadcast) => {
      if (m.type === 'session:updated') receiveSession(m.session);
      if (m.type === 'files:updated') setFiles(m.status);
      if (m.type === 'sources:updated' && !scanTimer)
        scanTimer = setTimeout(() => {
          scanTimer = undefined;
          void scan().catch(() => {});
        }, 500);
    };
    const activated = () => void scan().catch(() => {});
    // Network events cannot detect a newly replaced player or a delayed src
    // assignment on their own. Keep watching while this panel is visible, but
    // skip a poll when an event-driven scan just ran.
    const polling = setInterval(() => {
      if (!document.hidden && Date.now() - lastScan.current >= POLL_MS - 500) activated();
    }, POLL_MS);
    const visible = () => {
      if (!document.hidden) activated();
    };
    document.addEventListener('visibilitychange', visible);
    const updated = (
      _id: number,
      change: { url?: string; status?: string },
      current: chrome.tabs.Tab,
    ) => {
      if (current.active && (change.url || change.status === 'complete')) activated();
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    const onSettings = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.settings)
        setSettings((old) => ({
          ...old,
          uiLanguage: normalizeUILanguage(
            (changes.settings!.newValue as Partial<Settings> | undefined)?.uiLanguage,
          ),
          hasKey: Boolean((changes.settings!.newValue as Partial<Settings> | undefined)?.apiKey),
          autoSaveFiles:
            (changes.settings!.newValue as Partial<Settings> | undefined)?.autoSaveFiles === true,
        }));
    };
    chrome.storage.onChanged.addListener(onSettings);
    return () => {
      mounted.current = false;
      clearInterval(polling);
      document.removeEventListener('visibilitychange', visible);
      clearTimeout(scanTimer);
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.storage.onChanged.removeListener(onSettings);
    };
    // Browser listeners are registered once per panel lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = translate(locale, '听译 · 原音色视频翻译');
  }, [locale]);
  const changeLocale = (next: UILanguage) => {
    const previous = locale;
    setSettings((old) => ({ ...old, uiLanguage: next }));
    void act('locale', async () => {
      try {
        await call('ui:set', { language: next });
      } catch (e) {
        setSettings((old) => ({ ...old, uiLanguage: previous }));
        throw e;
      }
    });
  };
  const candidate = videos.find((v) => candidateKey(v) === selected);
  const chooseVideo = (candidate: MediaCandidate) => {
    setSelected(candidateKey(candidate));
    if (!candidate.detectionOnly)
      void call('media:highlight', {
        tabId: candidate.tabId,
        frameId: candidate.frameId,
        id: candidate.id,
      }).catch((error) => setError(error.message));
  };
  const mix = (changes: MixChanges) => {
    const current = sessionRef.current;
    if (!current) return;
    const next = { ...current, ...changes, ...mergeCaptionPreferences(current, changes) };
    sessionRef.current = next;
    setSession(next);
    void call('session:mix', {
      sessionId: next.id,
      languageVersion: next.languageVersion ?? 0,
      originalVolume: next.originalVolume,
      dubVolume: next.dubVolume,
      ...captionPreferences(next),
    }).catch((error) => {
      if (
        sessionRef.current?.id === next.id &&
        (sessionRef.current.languageVersion ?? 0) === (next.languageVersion ?? 0)
      )
        setError(error.message);
    });
  };
  const toggleFiles = (enabled: boolean) => {
    const previous = settings.autoSaveFiles;
    setSettings((old) => ({ ...old, autoSaveFiles: enabled }));
    void act('files-toggle', async () => {
      try {
        const next = await call('files:set-enabled', { enabled });
        setSettings((old) => ({ ...old, autoSaveFiles: next.autoSaveFiles }));
      } catch (error) {
        setSettings((old) => ({ ...old, autoSaveFiles: previous }));
        throw error;
      }
    });
  };
  const save = async () => {
    const next = await call('settings:save', {
      settings: {
        apiKey,
        workspace: settings.workspace,
        region: settings.region,
        language,
        uiLanguage: locale,
      },
    });
    setSettings(next);
    setApiKey('');
    setNotice('配置已保存在这台浏览器中');
  };
  const exportDiagnostics = async () => {
    const r = await call('session:diagnostics');
    if (!r.ok) throw new Error(r.error);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(r.value, null, 2)], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = locale === 'zh' ? '听译-播放诊断.json' : 'timbradub-playback-diagnostics.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setNotice('播放诊断已导出，不含密钥和媒体地址');
  };
  const status = t(session ? phaseNames[session.phase] : '未开始');
  return (
    <div className="app">
      <header className="header" aria-label={t('听译 · 原音色视频翻译')}>
        <div className="brand">
          <span className="brand-icon">
            <img src="/brand/logo.svg" width="40" height="40" alt="" />
          </span>
          <div>
            <strong>{t('听译')}</strong>
            <span>{t('原声音色')}</span>
          </div>
        </div>
        <div className="header-actions">
          <select
            className="locale-select"
            aria-label={t('界面语言')}
            value={locale}
            disabled={!loaded || !!busy}
            onChange={(e) => changeLocale(e.target.value as UILanguage)}
          >
            <option value="en">English</option>
            <option value="zh">简体中文</option>
          </select>
          <button
            className={`icon-button ${view === 'settings' ? 'active' : ''}`}
            aria-label={t('打开设置')}
            onClick={() => {
              setView(view === 'settings' ? 'videos' : 'settings');
              setError('');
              setNotice('');
            }}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <div className="modebar">
        <span className={`status-dot ${session?.phase === 'playing' ? 'live' : ''}`} />
        <span>{status}</span>
        <span className="modebar-end">{t('原网页 · 同步译音')}</span>
      </div>
      <main>
        {view === 'settings' ? (
          <SettingsView
            locale={locale}
            settings={settings}
            apiKey={apiKey}
            busy={busy}
            activeSession={!!session}
            saving={files.saving}
            onBack={() => setView('videos')}
            onApiKey={setApiKey}
            onSettings={setSettings}
            onSave={() => void act('save', save)}
            onTest={() =>
              void act('test', async () => {
                await save();
                const result = await call('settings:test');
                if (!result.ok) throw new Error(result.error);
                setNotice(result.value);
              })
            }
            onForget={() =>
              void act('forget', async () => {
                const next = await call('settings:forget');
                setSettings(next);
                setApiKey('');
                setNotice('本机凭据已移除');
              })
            }
            onDiagnostics={() => void act('diagnostics', exportDiagnostics)}
            onAction={act}
            onNotice={setNotice}
          />
        ) : (
          <>
            <div className="section-heading">
              <div>
                <span className="eyebrow">{t('当前页面')}</span>
                <h1>{t('选择要观看的视频')}</h1>
              </div>
              <button
                className="icon-button"
                disabled={!!busy}
                aria-label={t('重新扫描视频')}
                onClick={() => act('scan', scan)}
              >
                <RefreshCw size={17} className={busy === 'scan' ? 'spin' : ''} />
              </button>
            </div>
            <p className="description">{t('用原声的音色，听另一种语言。')}</p>
            <VideoList
              videos={videos}
              selected={selected}
              locale={locale}
              onChoose={chooseVideo}
              onScan={() => void act('scan', scan)}
            />
            <p className="hint" role="status">
              <RefreshCw size={14} />
              {t('持续检测音轨中，找到可用资源后自动更新。')}
            </p>
            {candidate?.site === 'youtube' && (
              <p className="hint">
                <CircleHelp size={14} />
                {t('YouTube 长视频尚未通过连续译音验收；遇到音轨播放验证限制时会停止翻译。')}
              </p>
            )}
            {candidate && !candidate.source && (
              <p className="hint">
                <CircleHelp size={14} />
                {candidate.sourceReason
                  ? localizeMessage(candidate.sourceReason, locale)
                  : t('先播放几秒，让浏览器发现音轨，再点击重新扫描。')}
              </p>
            )}
            {!settings.hasKey && <ProviderNotice locale={locale} />}
            <section className="language-section">
              <label htmlFor="language">
                <Languages size={17} />
                {t('翻译成')}
              </label>
              <select
                id="language"
                value={language}
                disabled={!!busy}
                onChange={(e) => void changeLanguage(e.target.value)}
              >
                {LANGUAGES.map(([code]) => (
                  <option key={code} value={code}>
                    {languageName(code, locale)}
                  </option>
                ))}
              </select>
              <span className="auto-source">{t('自动识别原语言 · 保留原音色')}</span>
            </section>
            {!settings.hasKey ? (
              <button className="primary" onClick={() => setView('settings')}>
                <KeyRound size={17} />
                {t('先连接百炼账户')}
                <ArrowRight size={16} />
              </button>
            ) : session ? (
              <button
                className="stop"
                disabled={!!busy}
                onClick={() =>
                  act('stop', async () => {
                    await call('session:stop');
                    receiveSession(null);
                  })
                }
              >
                <Square size={14} fill="currentColor" />
                {t('停止翻译')}
              </button>
            ) : (
              <button
                className="primary"
                disabled={!!busy || !candidate || !!candidate.sourceReason}
                onClick={() =>
                  act('start', async () => {
                    if (!candidate) return;
                    const s = await call('session:start', {
                      candidate,
                      language,
                    });
                    receiveSession(s);
                  })
                }
              >
                {busy === 'start' ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Headphones size={18} />
                )}
                {t('开始翻译')}
                <ArrowRight size={16} />
              </button>
            )}
            {session ? (
              <PlaybackView session={session} mix={mix} locale={locale} />
            ) : (
              <div className="how-it-works">
                <span className="step-number">01</span>
                <p>
                  {t('先准备一小段译音，再边看边翻译。')}
                  <small>{t('暂停、跳转和倍速，译音跟随视频。')}</small>
                </p>
              </div>
            )}
          </>
        )}
        <LocalFilesView
          settings={settings}
          files={files}
          busy={busy}
          loaded={loaded}
          locale={locale}
          onToggle={toggleFiles}
          onShow={() =>
            void act('files-show', async () => {
              if (files.lastDownloadId !== undefined)
                await call('files:show', { id: files.lastDownloadId });
            })
          }
          onRetry={() =>
            void act('files-retry', async () => {
              setFiles(await call(files.error ? 'files:retry' : 'files:merge'));
            })
          }
        />
        {(error || session?.error) && (
          <div className="feedback error" role="alert">
            {localizeMessage(error || session?.error || '', locale)}
          </div>
        )}
        {notice && (
          <div className="feedback success" role="status">
            <Check size={14} />
            {localizeMessage(notice, locale)}
          </div>
        )}
      </main>
      <footer>
        <span className="footer-mark">
          <AudioLines size={12} />
          {t('由 Qwen 提供译音')}
        </span>
        <span>
          {t('自用预览版 · {version}', {
            version: chrome.runtime.getManifest().version,
          })}
        </span>
      </footer>
    </div>
  );
}
