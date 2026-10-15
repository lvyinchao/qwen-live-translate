import type { MediaCandidate, TranslationSegment, UILanguage } from './types';
export interface CompatState {
  id: string;
  candidate: MediaCandidate;
  language: string;
  uiLanguage: UILanguage;
  phase:
    | 'preparing'
    | 'recording'
    | 'buffering'
    | 'ended'
    | 'error'
    | 'stopped';
  capturedThrough: number;
  readyThrough: number;
  position: number;
  chunks: number;
  bytes: number;
  inputRms?: number;
  utterances?: number;
  sourcePaused: boolean;
  error?: string;
}
export type CompatPacket =
  | { type: 'state'; state: CompatState }
  | { type: 'segment'; segment: TranslationSegment }
  | { type: 'chunk'; seq: number; blob: Blob };
// Hysteresis keeps the capture producer bounded without rapid pause/resume.
export function captureShouldPause(
  captured: number,
  ready: number,
  position: number,
  paused: boolean,
) {
  return paused
    ? captured - position > 60 || captured - ready > 35
    : captured - position > 90 || captured - ready > 65;
}
export function compatCanPlay(
  position: number,
  ready: number,
  buffered: number,
  ended: boolean,
  initial: boolean,
) {
  const available = Math.min(ready, buffered) - position;
  return (
    available >= (initial && !ended ? 30 : 0.25) || (ended && available > 0.02)
  );
}
export const COMPAT_DISK_LIMIT = 2 * 1024 ** 3;

export function compatError(message: string, language: UILanguage) {
  if (/Extension has not been invoked|activeTab permission/.test(message))
    return language === 'zh'
      ? '请切回视频标签页，点击一次扩展工具栏图标，再开始兼容翻译。'
      : 'Return to the video tab and click the extension toolbar icon once, then start compatibility translation.';
  if (language !== 'zh') return message;
  const messages: Record<string, string> = {
    'Tab capture ended. Source settings restored.':
      '标签页采集已结束，原播放器设置已恢复。',
    'Missing capture session.': '缺少采集任务，请从扩展侧边栏开始。',
    'This capture session has ended.': '这次采集已结束，请重新开始。',
    'Click Play to begin watching.': '请点击播放以开始观看。',
    'Click Play to enable translated audio.': '请点击播放以允许播放译音。',
    'The captured video could not be played.':
      '录制画面无法播放，请停止后重试。',
    'Video playback failed.': '视频播放失败，请停止后重试。',
    'Tab capture did not provide both audio and video.':
      '未能同时取得标签页的画面与音频。',
    'Captured audio cannot be decoded.': '采集音频无法解码。',
    'Capture decoder failed.': '采集音频解码失败。',
    'This Chrome cannot record VP8/Opus WebM.':
      '此 Chrome 无法录制所需的 WebM 音视频。',
    'Chrome stopped recording the tab.': 'Chrome 已停止标签页录制。',
    'Local capture storage cannot keep up. Free disk space and retry.':
      '本机存储写入跟不上采集，请释放磁盘空间后重试。',
    'Temporary capture reached 2 GiB. Stop and start a new compatibility session.':
      '本次临时录制已达 2 GiB，请停止后重新开始兼容翻译。',
    'Choose a normal video player after ads have finished.':
      '请等待广告结束，再选择普通点播播放器。',
    'Protected video capture is not supported.': '暂不支持受保护视频的采集。',
    'Configure your Model Studio credentials first.': '请先设置百炼凭据。',
    'The player cannot be controlled. Rescan this page.':
      '无法控制播放器，请重新扫描。',
    'The selected player is missing or protected.':
      '所选播放器已消失或受到保护。',
    'Capture source was replaced.': '采集来源已被网页替换。',
    'Click Play in the source tab to allow capture.':
      '请在原标签页点击播放，允许采集继续。',
  };
  return messages[message] ?? message;
}

/** Flow control only. Translation and playback continue to use encoded timestamps. */
export class CaptureClock {
  private started = 0;
  private pausedAt: number | null = null;
  private pausedMs = 0;
  start(now: number) {
    this.started = now;
    this.pausedAt = null;
    this.pausedMs = 0;
  }
  pause(now: number) {
    this.pausedAt ??= now;
  }
  resume(now: number) {
    if (this.pausedAt !== null) this.pausedMs += now - this.pausedAt;
    this.pausedAt = null;
  }
  seconds(now: number) {
    return Math.max(
      0,
      ((this.pausedAt ?? now) - this.started - this.pausedMs) / 1000,
    );
  }
}
