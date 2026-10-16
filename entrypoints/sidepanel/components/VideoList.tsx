import { Check, RefreshCw, Video } from 'lucide-react';
import type { MediaCandidate, UILanguage } from '../../../lib/types';
import { localizeMessage } from '../../../lib/i18n';
import { candidateKey, time, translator } from '../ui';
export function VideoList({ videos, selected, onChoose, onScan, locale }: {
  videos: MediaCandidate[]; selected: string; onChoose: (candidate: MediaCandidate) => void;
  onScan: () => void; locale: UILanguage;
}) {
  const t = translator(locale);
  return (
<section className="video-list" aria-label={t('当前页面的视频')}>
              {videos.length ? (
                videos.map((v) => (
                  <button
                    key={`${v.frameId}:${v.id}`}
                    className={`video-choice ${candidateKey(v) === selected ? 'selected' : ''}`}
                    onClick={() => onChoose(v)}
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
                      {candidateKey(v) === selected && <span />}
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
                    onClick={onScan}
                  >
                    <RefreshCw size={13} />
                    {t('重新扫描')}
                  </button>
                </div>
              )}
            </section>
  );
}
