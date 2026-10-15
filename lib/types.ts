export type Site = 'youtube' | 'bilibili' | 'generic';
export interface AudioSource {
  url: string;
  mime?: string;
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
  tabId: number;
  frameId: number;
  site: Site;
  title: string;
  poster: string;
  duration: number;
  currentTime: number;
  width: number;
  height: number;
  paused: boolean;
  ad: boolean;
  source?: AudioSource;
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
export interface PlaybackSession {
  id: string;
  epoch: number;
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
  error?: string;
  diagnostic?: string;
  segments: Pick<
    TranslationSegment,
    'id' | 'start' | 'end' | 'sourceText' | 'text' | 'speaker' | 'skipped'
  >[];
}
export interface Settings {
  apiKey: string;
  workspace: string;
  region: 'cn-beijing' | 'ap-southeast-1';
  language: string;
}
export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  workspace: '',
  region: 'cn-beijing',
  language: 'zh',
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
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export function messageError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[\w-]+/g, '[已隐藏密钥]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(/https?:\/\/[^\s]+\?[^\s]+/g, '[媒体地址]');
}
