import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { UILanguage } from '../../../lib/types';
import { localizeMessage } from '../../../lib/i18n';
import { call, type StorageSummary } from '../api';
import { translator } from '../ui';
const bytes = (value: number) =>
  value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
type ClearOperation = 'cache:clear' | 'media:clear' | 'archives:clear';
export function StorageView(props: {
  locale: UILanguage;
  busy: string;
  activeSession: boolean;
  saving: boolean;
  onAction: (name: string, operation: () => Promise<void>) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const { locale } = props;
  const t = translator(locale);
  const [summary, setSummary] = useState<StorageSummary>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await call('storage:summary');
      if (mounted.current) setSummary(next);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, []);
  const clear = (type: ClearOperation) =>
    props.onAction(type, async () => {
      const next = await call(type);
      if (mounted.current) {
        setSummary(next);
        setError('');
      }
      props.onNotice(
        type === 'media:clear' && next.media.files > 0
          ? '已清理可删除的临时文件；仍在使用的文件会在任务关闭后清理。'
          : '浏览器中的暂存数据已清理，已下载文件不会删除。',
      );
    });
  const rows = [
    {
      title: t('译音播放缓存'),
      explanation: t('再次观看时复用译音，清除后需要重新生成。'),
      size: summary?.playback.bytes,
      detail: summary ? t('上限 {size}', { size: bytes(summary.playback.limitBytes) }) : '',
      action: 'cache:clear' as const,
      label: t('清除译音缓存'),
    },
    {
      title: t('原媒体临时文件'),
      explanation: t('为提前读取音轨临时存放，任务关闭后会清理。'),
      size: summary?.media.bytes,
      detail: summary ? t('{count} 个文件', { count: summary.media.files }) : '',
      action: 'media:clear' as const,
      label: t('清除原媒体临时文件'),
    },
    {
      title: t('译音与脚本暂存'),
      explanation: t('开启自动保存后的分段和待合并内容；不包含下载目录中的文件。'),
      size: summary?.archives.bytes,
      detail: summary
        ? t('{count} 段 · {jobs} 个视频', {
            count: summary.archives.parts,
            jobs: summary.archives.jobs,
          })
        : '',
      action: 'archives:clear' as const,
      label: t('清除译音与脚本暂存'),
    },
  ];
  return (
    <section className="storage-view" aria-label={t('本机存储空间')}>
      <div className="section-heading">
        <h2>{t('本机存储空间')}</h2>
        <button
          className="icon-button"
          aria-label={t('刷新存储统计')}
          disabled={loading || !!props.busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <dl>
        {rows.map((row) => (
          <div className="storage-row" key={row.action}>
            <dt>{row.title}</dt>
            <dd>
              <strong>{row.size === undefined ? '—' : bytes(row.size)}</strong>
              <span>{row.detail}</span>
            </dd>
            <p>{row.explanation}</p>
            <button
              className="text-button"
              aria-label={row.label}
              disabled={
                loading ||
                !!props.busy ||
                props.activeSession ||
                (row.action === 'archives:clear' && props.saving)
              }
              onClick={() => void clear(row.action)}
            >
              {row.label}
            </button>
          </div>
        ))}
      </dl>
      <p className="storage-note">{t('缓存按记录估算，浏览器实际占用可能略有差异。')}</p>
      {props.activeSession && <p className="storage-note">{t('停止翻译后可以清理本机空间。')}</p>}
      {error && (
        <p className="file-error" role="alert">
          {localizeMessage(error, locale)}
        </p>
      )}
    </section>
  );
}
