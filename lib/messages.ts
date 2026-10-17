import type { ArchiveStorageSummary } from './local-files';
import type { LocalFileStatus } from './archive';
import type { MediaTempSummary } from './range-media';
import type {
  AudioSource,
  MediaCandidate,
  PlaybackSession,
  Settings,
  UILanguage,
} from './types';
import type { ErrorCode } from './errors';

export type PublicSettings = Omit<Settings, 'apiKey'> & { hasKey: boolean };
export interface StorageSummary {
  playback: { bytes: number; limitBytes: number };
  media: MediaTempSummary;
  archives: ArchiveStorageSummary;
}
/** Identifies one seek/language revision of a translation task. */
export interface SessionRevision {
  sessionId?: string;
  epoch?: number;
  languageVersion?: number;
}
export interface CaptionChanges {
  subtitles?: boolean;
  sourceSubtitles?: boolean;
  targetSubtitles?: boolean;
}
export interface TencentMediaInfo {
  videoId?: string;
  url?: string;
  playlist?: string;
  protected?: boolean;
  playerId?: string;
}

type Empty = Record<never, never>;
type Route<Request, Response> = { request: Request; response: Response };
/** Every message the background accepts, keyed by `type`. Requests only describe
 * the shape callers send: handlers still validate values from other contexts. */
export interface BackgroundApi {
  'files:set-enabled': Route<{ enabled: boolean }, PublicSettings>;
  'files:status': Route<Empty, LocalFileStatus>;
  'files:merge': Route<Empty, LocalFileStatus>;
  'files:retry': Route<Empty, LocalFileStatus>;
  'files:show': Route<{ id: number }, boolean>;
  'files:download': Route<{ url: string; filename: string }, number>;
  'ui:get': Route<Empty, UILanguage>;
  'ui:set': Route<{ language: UILanguage }, UILanguage>;
  'settings:get': Route<Empty, PublicSettings>;
  'settings:save': Route<{ settings: Partial<Settings> }, PublicSettings>;
  'settings:forget': Route<Empty, PublicSettings>;
  'settings:test': Route<Empty, Result<string>>;
  'media:tencent-info': Route<{ media: TencentMediaInfo }, boolean>;
  'media:discover': Route<{ tabId: number }, MediaCandidate[]>;
  'media:refresh': Route<SessionRevision, AudioSource | undefined>;
  'media:diagnostics': Route<Empty, unknown>;
  'media:highlight': Route<{ tabId: number; frameId: number; id: string }, boolean>;
  'media:headers': Route<SessionRevision & { source: AudioSource }, boolean>;
  'session:get': Route<Empty, PlaybackSession | null>;
  'session:diagnostics': Route<Empty, Result<unknown>>;
  'session:start': Route<{ candidate: MediaCandidate; language?: string }, PlaybackSession | null>;
  'session:language': Route<{ sessionId: string; language: string }, PlaybackSession | null>;
  'session:stop': Route<Empty, boolean>;
  'session:mix': Route<
    SessionRevision & CaptionChanges & { originalVolume?: number; dubVolume?: number },
    boolean
  >;
  'auth:install': Route<SessionRevision, string>;
  'auth:remove': Route<Empty, boolean>;
  'engine:state': Route<{ session: PlaybackSession }, boolean>;
  'engine:segment': Route<SessionRevision & { segment: unknown }, boolean>;
  'player:clock': Route<PlayerReport, unknown>;
  'player:seek': Route<PlayerReport, unknown>;
  'player:lost': Route<PlayerReport, unknown>;
  'player:skip': Route<PlayerReport, unknown>;
  'player:metric': Route<PlayerReport, unknown>;
  'storage:summary': Route<Empty, StorageSummary>;
  'cache:clear': Route<Empty, StorageSummary>;
  'media:clear': Route<Empty, StorageSummary>;
  'archives:clear': Route<Empty, StorageSummary>;
}
/** Engine → decode worker request for one window of source audio. */
export interface DecodeRequest {
  id: string;
  type: 'decode';
  source: AudioSource;
  start: number;
  end: number;
  expectedDuration: number;
}
/** Content-script reports carry arbitrary player measurements to the engine. */
export type PlayerReport = SessionRevision & Record<string, unknown>;
export type BackgroundType = keyof BackgroundApi;
export type BackgroundRequest<K extends BackgroundType> = BackgroundApi[K]['request'];
export type BackgroundResponse<K extends BackgroundType> = BackgroundApi[K]['response'];
export type BackgroundMessage<K extends BackgroundType = BackgroundType> = {
  [T in K]: { target?: 'background'; type: T } & BackgroundRequest<T>;
}[K];
/** Parameters are optional only for routes whose request has no required fields. */
export type RequestArgs<K extends BackgroundType> = Empty extends BackgroundRequest<K>
  ? [parameters?: BackgroundRequest<K>]
  : [parameters: BackgroundRequest<K>];
export type BackgroundCall = <K extends BackgroundType>(
  type: K,
  ...args: RequestArgs<K>
) => Promise<BackgroundResponse<K>>;
/** Notifications sent to extension pages; nobody answers them. */
export type Broadcast =
  | { type: 'session:updated'; session: PlaybackSession | null }
  | { type: 'files:updated'; status: LocalFileStatus }
  | { type: 'sources:updated'; tabId: number };
/** Messages the background broadcasts and must not answer itself. */
export const BROADCASTS = ['session:updated', 'files:updated', 'sources:updated'] as const;
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: ErrorCode };
