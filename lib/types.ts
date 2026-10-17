export type Site =
  | 'youtube'
  | 'bilibili'
  | 'youku'
  | 'iqiyi'
  | 'tencent'
  | 'generic';
export interface AudioSource {
  url: string;
  mime?: string;
  kind?: 'file' | 'hls';
  hlsManifest?: string;
  headers?: Record<string, string>;
  identity: string;
  /** Native SABR request, kept in extension memory only. Never contains model credentials. */
  sabrRequest?: string;
  trackId?: string;
  sabrFormats?: {
    itag: number;
    lastModified: string;
    xtags?: string;
    audioTrackId?: string;
    isDefault?: boolean;
    isDrc?: boolean;
    mimeType?: string;
    bitrate?: number;
    audioChannels?: number;
    audioQuality?: string;
    approxDurationMs?: string;
  }[];
}
export interface MediaCandidate {
  id: string;
  mediaId: string;
  /** Page lifecycle identity, separate from the selected media cache identity. */
  pageId?: string;
  tabId: number;
  frameId: number;
  frameMediaId?: string;
  site: Site;
  title: string;
  poster: string;
  duration: number;
  currentTime: number;
  width: number;
  height: number;
  paused: boolean;
  playbackRate?: number;
  ad: boolean;
  source?: AudioSource;
  detectionOnly?: boolean;
  sourceReason?: string;
  detectedMedia?: { kind: string; count: number }[];
  protected?: boolean;
  sourceStatus: 'ready' | 'discovering' | 'unsupported';
}
export interface TranslationSegment {
  id: string;
  mediaId: string;
  language: string;
  voice: string;
  start: number;
  end: number;
  sourceText: string;
  text: string;
  speaker?: number;
  audio: string;
  audioDuration: number;
  skipped?: boolean;
}
export type Phase =
  | 'idle'
  | 'preparing'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'error'
  | 'ended';
export interface PreparationStatus {
  videoRate: number;
  startupTargetSeconds: number;
  maintainTargetSeconds: number;
  maxAheadSeconds: number;
  inputRealtimeFactor: number;
  preparedRealtimeFactor?: number;
  netBufferSecondsPerSecond: number;
  limitedByRealtimeInput: boolean;
}
export interface PlaybackSession {
  id: string;
  epoch: number;
  languageVersion?: number;
  /** Monotonic engine snapshot sequence within this seek/language revision. */
  stateVersion?: number;
  candidate: MediaCandidate;
  language: string;
  phase: Phase;
  position: number;
  rate: number;
  readyThrough: number;
  inputThrough: number;
  skipped: number;
  originalVolume: number;
  dubVolume: number;
  subtitles: boolean;
  sourceSubtitles?: boolean;
  targetSubtitles?: boolean;
  error?: string;
  diagnostic?: string;
  preparation?: PreparationStatus;
  segments: Pick<
    TranslationSegment,
    'id' | 'start' | 'end' | 'sourceText' | 'text' | 'speaker' | 'skipped'
  >[];
}
export type UILanguage = 'en' | 'zh';
export interface Settings {
  apiKey: string;
  workspace: string;
  region: 'cn-beijing' | 'ap-southeast-1';
  language: string;
  uiLanguage: UILanguage;
  autoSaveFiles: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  workspace: '',
  region: 'cn-beijing',
  language: 'zh',
  uiLanguage: 'en',
  autoSaveFiles: false,
};
export const MODEL = 'qwen3.8-livetranslate-flash-realtime';
export const VOICE = 'original-auto-v1';
export const MODEL_VOICE = 'default';
export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;
export const CACHE_LIMIT = 128 * 1024 * 1024;
export const LANGUAGES = [
  ['zh', '中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['pt', 'Português'],
  ['ru', 'Русский'],
  ['ar', 'العربية'],
  ['it', 'Italiano'],
  ['id', 'Bahasa Indonesia'],
  ['th', 'ไทย'],
  ['vi', 'Tiếng Việt'],
  ['tr', 'Türkçe'],
  ['hi', 'हिन्दी'],
  ['ms', 'Bahasa Melayu'],
  ['nl', 'Nederlands'],
  ['ur', 'اردو'],
  ['nb', 'Norsk'],
  ['sv', 'Svenska'],
  ['da', 'Dansk'],
  ['he', 'עברית'],
  ['fi', 'Suomi'],
  ['pl', 'Polski'],
  ['is', 'Íslenska'],
  ['cs', 'Čeština'],
  ['fil', 'Filipino'],
  ['fa', 'فارسی'],
] as const;
export type Envelope = {
  target?: 'background' | 'offscreen';
  type: string;
  [key: string]: unknown;
};
export type { Result } from './messages';
export function messageError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[\w-]+/g, '[已隐藏密钥]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(/https?:\/\/[^\s]+\?[^\s]+/g, '[媒体地址]');
}
