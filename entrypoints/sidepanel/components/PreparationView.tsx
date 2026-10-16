import type { PlaybackSession, UILanguage } from '../../../lib/types';
import { translator } from '../ui';
export function PreparationView({ session, locale }: { session: PlaybackSession; locale: UILanguage }) {
  const t = translator(locale);
  const preparation = session.preparation;
  if (!preparation) return null;
  const throughput = preparation.preparedRealtimeFactor ?? 0;
  return <div className="preparation-card" aria-label={t('译音准备状态')}>
    <div>{t('启动准备 {seconds} 秒 · 持续准备 {maintain} 秒', {
      seconds: preparation.startupTargetSeconds.toFixed(0), maintain: preparation.maintainTargetSeconds.toFixed(0),
    })}</div>
    <p>{throughput > 0 ? t('实际准备速度 {rate}× · 当前播放 {videoRate}×', {
      rate: throughput.toFixed(2), videoRate: preparation.videoRate.toFixed(1),
    }) : t('正在测量实际准备速度…')}</p>
    {preparation.limitedByRealtimeInput && <small>{t('模型音频按原速输入，倍速观看可能需要再次缓冲。')}</small>}
    {throughput > 0 && preparation.netBufferSecondsPerSecond < -0.05 &&
      <small className="preparation-limit">{t('当前播放快于准备速度，缓存耗尽时会暂停等待。')}</small>}
  </div>;
}
