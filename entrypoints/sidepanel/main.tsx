import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AudioLines,
  ArrowRight,
  Check,
  ChevronLeft,
  CircleHelp,
  ExternalLink,
  Headphones,
  KeyRound,
  Languages,
  LoaderCircle,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Subtitles,
  Video,
  Volume2,
} from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  type MediaCandidate,
  type PlaybackSession,
  type Result,
  type Settings,
} from '../../lib/types';
import {
  languageName,
  localizeMessage,
  normalizeUILanguage,
  t as translate,
  type MessageKey,
} from '../../lib/i18n';
import type { UILanguage } from '../../lib/types';
import { EMPTY_FILE_STATUS, type LocalFileStatus } from '../../lib/archive';
import './style.css';

async function call<T = unknown>(
  type: string,
  parameters: Record<string, unknown> = {},
): Promise<T> {
  const result = (await chrome.runtime.sendMessage({
    target: 'background',
    type,
    ...parameters,
  })) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const time = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const phaseNames = {
  idle: '未开始',
  preparing: '准备中',
  buffering: '准备译音',
  playing: '正在翻译',
  paused: '已暂停',
  ended: '已结束',
  error: '需要处理',
} as const;
type PublicSettings = Omit<Settings, 'apiKey'> & { hasKey: boolean };
function App() {
  const [view, setView] = useState<'videos' | 'settings'>('videos');
  const [settings, setSettings] = useState<PublicSettings>({
    ...DEFAULT_SETTINGS,
    hasKey: false,
  });
  const locale = settings.uiLanguage;
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    translate(locale, key, values);
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
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const scan = async () => {
    const [current] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    setTab(current);
    if (!current?.id || !current.url || !/^https?:\/\//.test(current.url)) {
      setVideos([]);
      return;
    }
    const items = await call<MediaCandidate[]>('media:discover', {
      tabId: current.id,
    });
    items.sort((a, b) => b.width * b.height - a.width * a.height);
    setVideos(items);
    setSelected((old) =>
      items.some((v) => v.id === old) ? old : (items[0]?.id ?? ''),
    );
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
    void call<PublicSettings>('settings:get')
      .then((s) => {
        setSettings(s);
        setLanguage(s.language);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
    void call<PlaybackSession | null>('session:get').then(setSession);
    void call<LocalFileStatus>('files:status')
      .then(setFiles)
      .catch((e) => setFiles((old) => ({ ...old, error: e.message })));
    void scan().catch((e) => setError(e.message));
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    const listener = (m: any) => {
      if (m.type === 'session:updated') setSession(m.session);
      if (m.type === 'files:updated') setFiles(m.status);
      if (m.type === 'sources:updated' && !scanTimer)
        scanTimer = setTimeout(() => {
          scanTimer = undefined;
          void scan().catch(() => {});
        }, 500);
    };
    const activated = () => void scan().catch(() => {});
    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.onActivated.addListener(activated);
    const onSettings = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes.settings)
        setSettings((old) => ({
          ...old,
          uiLanguage: normalizeUILanguage(
            (changes.settings!.newValue as Partial<Settings> | undefined)
              ?.uiLanguage,
          ),
        }));
    };
    chrome.storage.onChanged.addListener(onSettings);
    return () => {
      clearTimeout(scanTimer);
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.storage.onChanged.removeListener(onSettings);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = translate(locale, '听译 · 视频译音');
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
  const candidate = videos.find((v) => v.id === selected);
  const mix = (
    changes: Partial<
      Pick<PlaybackSession, 'originalVolume' | 'dubVolume' | 'subtitles'>
    >,
  ) => {
    if (!session) return;
    const next = { ...session, ...changes };
    setSession(next);
    void call('session:mix', {
      originalVolume: next.originalVolume,
      dubVolume: next.dubVolume,
      subtitles: next.subtitles,
    }).catch((e) => setError(e.message));
  };
  const save = async () => {
    const next = await call<PublicSettings>('settings:save', {
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
    const r = await call<Result<unknown>>('session:diagnostics');
    if (!r.ok) throw new Error(r.error);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(r.value, null, 2)], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download =
      locale === 'zh'
        ? '听译-播放诊断.json'
        : 'qwen-dub-playback-diagnostics.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setNotice('播放诊断已导出，不含密钥和媒体地址');
  };
  const status = t(session ? phaseNames[session.phase] : '未开始');
  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-icon">
            <AudioLines size={23} />
          </span>
          <div>
            <strong>{t('听译')}</strong>
            <span>QWEN VIDEO DUB</span>
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
        <span
          className={`status-dot ${session?.phase === 'playing' ? 'live' : ''}`}
        />
        <span>{status}</span>
        <span className="modebar-end">{t('原网页 · 同步译音')}</span>
      </div>
      <main>
        {view === 'settings' ? (
          <>
            <button className="back" onClick={() => setView('videos')}>
              <ChevronLeft size={16} />
              {t('返回视频')}
            </button>
            <div className="section-heading">
              <h1>{t('连接你的百炼')}</h1>
              <KeyRound size={20} />
            </div>
            <p className="description">
              {t(
                '使用自己的账户调用模型。凭据只保存在本机，不会提供给视频网页。',
              )}
            </p>
            <section className="settings-form">
              <label htmlFor="api-key">
                API Key{' '}
                <span>{settings.hasKey ? t('已保存') : t('待填写')}</span>
              </label>
              <input
                id="api-key"
                type="password"
                autoComplete="off"
                placeholder={
                  settings.hasKey ? t('留空保留已保存的 Key') : 'sk-…'
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <label htmlFor="workspace">Workspace ID</label>
              <input
                id="workspace"
                autoComplete="off"
                placeholder={t('百炼业务空间 ID')}
                value={settings.workspace}
                onChange={(e) =>
                  setSettings({ ...settings, workspace: e.target.value })
                }
              />
              <label htmlFor="region">{t('服务地域')}</label>
              <select
                id="region"
                value={settings.region}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    region: e.target.value as Settings['region'],
                  })
                }
              >
                <option value="cn-beijing">{t('华北 2 · 北京')}</option>
                <option value="ap-southeast-1">{t('新加坡')}</option>
              </select>
              <button
                className="primary"
                disabled={
                  !!busy || !settings.workspace || (!apiKey && !settings.hasKey)
                }
                onClick={() => act('save', save)}
              >
                {busy === 'save' ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Check size={17} />
                )}
                {t('保存配置')}
              </button>
              <button
                className="secondary"
                disabled={!!busy || (!apiKey && !settings.hasKey)}
                onClick={() =>
                  act('test', async () => {
                    await save();
                    const result = await call<Result<string>>('settings:test');
                    if (!result.ok) throw new Error(result.error);
                    setNotice(result.value);
                  })
                }
              >
                {busy === 'test' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <AudioLines size={16} />
                )}
                {t('验证连接')}
              </button>
            </section>
            <div className="model-note">
              <span className="eyebrow">{t('当前模型')}</span>
              <strong>Qwen3.8 LiveTranslate</strong>
              <p>
                {t(
                  '支持 29 种语言译音，随原说话人复刻音色。费用由百炼账户按实际用量结算。',
                )}
              </p>
            </div>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() => act('diagnostics', exportDiagnostics)}
            >
              {t('导出最近一次播放诊断')}
            </button>
            <div className="settings-actions">
              <button
                disabled={!!busy || !!session}
                onClick={() =>
                  act('cache', async () => {
                    await call('cache:clear');
                    setNotice('译音缓存已清除');
                  })
                }
              >
                {t('清除译音缓存')}
              </button>
              <button
                disabled={!!busy}
                onClick={() =>
                  act('forget', async () => {
                    const next = await call<PublicSettings>('settings:forget');
                    setSettings(next);
                    setApiKey('');
                    setNotice('本机凭据已移除');
                  })
                }
              >
                {t('移除凭据')}
              </button>
            </div>
          </>
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
                <RefreshCw
                  size={17}
                  className={busy === 'scan' ? 'spin' : ''}
                />
              </button>
            </div>
            <p className="description">
              {t('保留熟悉的播放器，换一种语言听懂内容。')}
            </p>
            <section className="video-list" aria-label={t('当前页面的视频')}>
              {videos.length ? (
                videos.map((v) => (
                  <button
                    key={`${v.frameId}:${v.id}`}
                    className={`video-choice ${v.id === selected ? 'selected' : ''}`}
                    onClick={() => {
                      setSelected(v.id);
                      if (!v.detectionOnly)
                        void call('media:highlight', {
                          tabId: v.tabId,
                          frameId: v.frameId,
                          id: v.id,
                        });
                    }}
                  >
                    <span className="video-poster">
                      {v.poster ? (
                        <img src={v.poster} alt="" />
                      ) : (
                        <Video size={25} />
                      )}
                      <span>
                        {v.detectionOnly ? t('媒体资源') : time(v.duration)}
                      </span>
                    </span>
                    <span className="video-info">
                      <strong>{v.title}</strong>
                      <small>
                        {v.site === 'youtube'
                          ? 'YouTube'
                          : v.site === 'bilibili'
                            ? 'Bilibili'
                            : v.site === 'youku'
                              ? 'Youku'
                              : v.site === 'iqiyi'
                                ? 'iQIYI'
                                : v.site === 'tencent'
                                  ? 'Tencent Video'
                                  : t('网页视频')}{' '}
                        {!v.detectionOnly && (
                          <>
                            · {v.width} × {v.height}
                          </>
                        )}
                      </small>
                      <span
                        className={`source-state ${v.source ? 'available' : ''}`}
                      >
                        {v.source ? (
                          <Check size={11} />
                        ) : (
                          <span className="tiny-dot" />
                        )}
                        {v.sourceReason
                          ? localizeMessage(v.sourceReason, locale)
                          : v.source
                            ? t('音轨已识别')
                            : t('等待识别音轨')}
                        {!!v.detectedMedia?.length &&
                          ` · ${v.detectedMedia.map((r) => `${r.kind.toUpperCase()} × ${r.count}`).join(', ')}`}
                      </span>
                    </span>
                    <span className="radio">
                      {v.id === selected && <span />}
                    </span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <span>
                    <Video size={28} />
                  </span>
                  <strong>{t('让视频先出现')}</strong>
                  <p>{t('打开视频网站的点播页面，播放几秒后重新扫描。')}</p>
                  <button
                    className="text-button"
                    onClick={() => act('scan', scan)}
                  >
                    <RefreshCw size={13} />
                    {t('重新扫描')}
                  </button>
                </div>
              )}
            </section>
            {candidate?.site === 'youtube' && (
              <p className="hint">
                <CircleHelp size={14} />
                {t(
                  'YouTube 长视频尚未通过连续译音验收；遇到音轨播放验证限制时会停止翻译。',
                )}
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
            <section className="language-section">
              <label htmlFor="language">
                <Languages size={17} />
                {t('翻译成')}
              </label>
              <select
                id="language"
                value={language}
                disabled={!!session}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map(([code]) => (
                  <option key={code} value={code}>
                    {languageName(code, locale)}
                  </option>
                ))}
              </select>
              <span className="auto-source">
                {t('自动识别原语言 · 保留原音色')}
              </span>
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
                    setSession(null);
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
                    const s = await call<PlaybackSession>('session:start', {
                      candidate,
                      language,
                    });
                    setSession(s);
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
              <section className="session-section">
                <div className="session-line">
                  <strong>{t(phaseNames[session.phase])}</strong>
                  <span>
                    {time(session.position)} /{' '}
                    {time(session.candidate.duration)}
                  </span>
                </div>
                <div className="coverage-bar">
                  <span
                    style={{
                      width: `${Math.min(100, (session.readyThrough / session.candidate.duration) * 100)}%`,
                    }}
                  />
                  <i
                    style={{
                      left: `${Math.min(100, (session.position / session.candidate.duration) * 100)}%`,
                    }}
                  />
                </div>
                <div className="buffer-label">
                  <span>
                    {t('后续译音 {seconds} 秒', {
                      seconds: Math.max(
                        0,
                        session.readyThrough - session.position,
                      ).toFixed(0),
                    })}
                  </span>
                  <span>
                    {t('{rate}× 播放', { rate: session.rate.toFixed(1) })}
                  </span>
                </div>
                {['preparing', 'buffering'].includes(session.phase) && (
                  <p className="hint">
                    {t('正在提前准备译音，就绪后会自动继续播放。')}
                  </p>
                )}
                <div className="mix-row">
                  <label htmlFor="original">
                    <Volume2 size={15} />
                    {t('原声')}
                  </label>
                  <input
                    id="original"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={session.originalVolume}
                    onChange={(e) =>
                      mix({ originalVolume: Number(e.target.value) })
                    }
                  />
                  <span>{Math.round(session.originalVolume * 100)}%</span>
                </div>
                <div className="mix-row">
                  <label htmlFor="dub">
                    <Headphones size={15} />
                    {t('译音')}
                  </label>
                  <input
                    id="dub"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={session.dubVolume}
                    onChange={(e) => mix({ dubVolume: Number(e.target.value) })}
                  />
                  <span>{Math.round(session.dubVolume * 100)}%</span>
                </div>
                <label className="toggle-row">
                  <span>
                    <Subtitles size={16} />
                    {t('双语字幕')}
                  </span>
                  <input
                    type="checkbox"
                    checked={session.subtitles}
                    onChange={(e) => mix({ subtitles: e.target.checked })}
                  />
                </label>
                {session.skipped > 0 && (
                  <p className="skip-note">
                    {t(
                      '为跟随画面，已有 {count} 处过长译音跳过尾部。完整译文仍可查看。',
                      { count: session.skipped },
                    )}
                  </p>
                )}
                {session.segments.length > 0 && (
                  <div className="transcript">
                    <span className="eyebrow">{t('译文片段')}</span>
                    {session.segments
                      .filter(
                        (s) =>
                          s.start <= session.position + 30 &&
                          s.end >= session.position - 30,
                      )
                      .slice(-5)
                      .map((s) => (
                        <div
                          className={
                            s.start <= session.position &&
                            s.end > session.position
                              ? 'current'
                              : ''
                          }
                          key={s.id}
                        >
                          <time>{time(s.start)}</time>
                          <p>
                            {s.text}
                            <small>{s.sourceText}</small>
                            {s.skipped && (
                              <small className="skip-note">
                                {t('译音尾部已跳过')}
                              </small>
                            )}
                          </p>
                        </div>
                      ))}
                  </div>
                )}
              </section>
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
        <section className="local-files" aria-label={t('本地保存')}>
          <strong>{t('本地保存')}</strong>
          <p>
            {t(
              '片段自动暂存在本机，翻译结束或停止时合并为一个音频包；分段不发起下载。',
            )}
          </p>
          <span role="status">
            {files.saving
              ? t('正在合并并保存…')
              : files.saved
                ? t('已保存 {count} 个结果', { count: files.saved })
                : t('译音先分段保存，完成后自动合并')}
          </span>
          {!!files.staged && (
            <small>{t('已暂存 {count} 段译音', { count: files.staged })}</small>
          )}
          {files.pending > 0 && (
            <small>
              {t('有 {count} 个视频待合并', { count: files.pending })}
            </small>
          )}
          {files.error && (
            <p className="file-error" role="alert">
              {t('本地保存失败，待保存内容已保留，请重试。')}{' '}
              {localizeMessage(files.error, locale)}
            </p>
          )}
          <div className="file-actions">
            <button
              className="text-button"
              disabled={!!busy || files.lastDownloadId === undefined}
              onClick={() =>
                act('files-show', async () => {
                  await call('files:show', { id: files.lastDownloadId });
                })
              }
            >
              {t('查看已保存文件')}
            </button>
            {(files.pending > 0 || files.error) && (
              <button
                className="text-button"
                disabled={!!busy || files.saving}
                onClick={() =>
                  act('files-retry', async () => {
                    setFiles(
                      await call<LocalFileStatus>(
                        files.error ? 'files:retry' : 'files:merge',
                      ),
                    );
                  })
                }
              >
                {files.error ? t('重试保存') : t('合并并保存')}
              </button>
            )}
          </div>
        </section>
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
createRoot(document.getElementById('root')!).render(<App />);
