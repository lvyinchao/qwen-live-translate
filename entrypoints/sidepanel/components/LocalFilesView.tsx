import type { UILanguage } from '../../../lib/types';
import type { LocalFileStatus } from '../../../lib/archive';
import { localizeMessage } from '../../../lib/i18n';
import type { PublicSettings } from '../api';
import { translator } from '../ui';
export function LocalFilesView({
  settings,
  files,
  busy,
  loaded,
  locale,
  onToggle,
  onShow,
  onRetry,
}: {
  settings: PublicSettings;
  files: LocalFileStatus;
  busy: string;
  loaded: boolean;
  locale: UILanguage;
  onToggle: (enabled: boolean) => void;
  onShow: () => void;
  onRetry: () => void;
}) {
  const t = translator(locale);
  return (
    <section className="local-files" aria-label={t('本地保存')}>
      <strong>{t('本地保存')}</strong>
      <label className="toggle-row file-save-toggle">
        <span>{t('自动保存翻译文件')}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t('自动保存翻译文件')}
          checked={settings.autoSaveFiles}
          disabled={!!busy || !loaded}
          onChange={(event) => onToggle(event.target.checked)}
        />
      </label>
      <p>
        {t(
          settings.autoSaveFiles
            ? '片段自动暂存在本机，翻译结束或停止时合并为一个音频包；分段不发起下载。'
            : '关闭时仅使用播放缓存，不自动保存脚本、译音文件或发起下载。已有文件会保留。',
        )}
      </p>
      <span role="status">
        {files.saving
          ? t('正在合并并保存…')
          : files.saved
            ? t('已保存 {count} 个结果', { count: files.saved })
            : settings.autoSaveFiles
              ? t('译音先分段保存，完成后自动合并')
              : t('自动保存已关闭')}
      </span>
      {!!files.staged && <small>{t('已暂存 {count} 段译音', { count: files.staged })}</small>}
      {files.pending > 0 && <small>{t('有 {count} 个视频待合并', { count: files.pending })}</small>}
      {files.error && (
        <p className="file-error" role="alert">
          {t('本地保存失败，待保存内容已保留，请重试。')} {localizeMessage(files.error, locale)}
        </p>
      )}
      <div className="file-actions">
        <button
          className="text-button"
          disabled={!!busy || files.lastDownloadId === undefined}
          onClick={onShow}
        >
          {t('查看已保存文件')}
        </button>
        {(files.pending > 0 || files.error) && (
          <button className="text-button" disabled={!!busy || files.saving} onClick={onRetry}>
            {files.error ? t('重试保存') : t('合并并保存')}
          </button>
        )}
      </div>
    </section>
  );
}
