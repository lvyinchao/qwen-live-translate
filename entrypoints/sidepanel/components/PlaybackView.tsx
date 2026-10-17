import { Headphones, Subtitles, Volume2 } from 'lucide-react';
import type { PlaybackSession, UILanguage } from '../../../lib/types';
import { phaseNames, time, translator } from '../ui';
import { PreparationView } from './PreparationView';
import { captionPreferences } from '../../../lib/captions';
export type MixChanges = Partial<
  Pick<
    PlaybackSession,
    'originalVolume' | 'dubVolume' | 'subtitles' | 'sourceSubtitles' | 'targetSubtitles'
  >
>;
export function PlaybackView({
  session,
  mix,
  locale,
}: {
  session: PlaybackSession;
  mix: (changes: MixChanges) => void;
  locale: UILanguage;
}) {
  const t = translator(locale);
  const captions = captionPreferences(session);
  return (
    <section className="session-section">
      <div className="session-line">
        <strong>{t(phaseNames[session.phase])}</strong>
        <span>
          {time(session.position)} / {time(session.candidate.duration)}
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
            seconds: Math.max(0, session.readyThrough - session.position).toFixed(0),
          })}
        </span>
        <span>{t('{rate}× 播放', { rate: session.rate.toFixed(1) })}</span>
      </div>
      <PreparationView session={session} locale={locale} />
      {['preparing', 'buffering'].includes(session.phase) && (
        <p className="hint">{t('正在提前准备译音，就绪后会自动继续播放。')}</p>
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
          onChange={(e) => mix({ originalVolume: Number(e.target.value) })}
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
          {t('显示原语言字幕')}
        </span>
        <input
          type="checkbox"
          checked={captions.sourceSubtitles}
          onChange={(e) => mix({ sourceSubtitles: e.target.checked })}
        />
      </label>
      <label className="toggle-row">
        <span>
          <Subtitles size={16} />
          {t('显示目标语言字幕')}
        </span>
        <input
          type="checkbox"
          checked={captions.targetSubtitles}
          onChange={(e) => mix({ targetSubtitles: e.target.checked })}
        />
      </label>
      {session.skipped > 0 && (
        <p className="skip-note">
          {t('为跟随画面，已有 {count} 处译音截短尾部（含微小截尾）。完整译文仍可查看。', {
            count: session.skipped,
          })}
        </p>
      )}
      {session.segments.length > 0 && (
        <div className="transcript">
          <span className="eyebrow">{t('译文片段')}</span>
          {session.segments
            .filter((s) => s.start <= session.position + 30 && s.end >= session.position - 30)
            .slice(-5)
            .map((s) => (
              <div
                className={s.start <= session.position && s.end > session.position ? 'current' : ''}
                key={s.id}
              >
                <time>{time(s.start)}</time>
                <p>
                  {s.text}
                  <small>{s.sourceText}</small>
                  {s.skipped && <small className="skip-note">{t('译音尾部已截短')}</small>}
                </p>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
