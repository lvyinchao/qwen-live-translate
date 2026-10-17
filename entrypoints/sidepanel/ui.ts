import type { MediaCandidate, UILanguage } from '../../lib/types';
import { t, type MessageKey } from '../../lib/i18n';
export const translator =
  (locale: UILanguage) => (key: MessageKey, values?: Record<string, string | number>) =>
    t(locale, key, values);
export const time = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
export const candidateKey = (candidate: MediaCandidate) =>
  `${candidate.tabId}:${candidate.frameId}:${candidate.id}`;
export const phaseNames = {
  idle: '未开始',
  preparing: '准备中',
  buffering: '准备译音',
  playing: '正在翻译',
  paused: '已暂停',
  ended: '已结束',
  error: '需要处理',
} as const;
