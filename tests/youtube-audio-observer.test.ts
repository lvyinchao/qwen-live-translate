import { afterEach, expect, it, vi } from 'vitest';
import { registerMediaObserver, type SourceRecord } from '../lib/media-observer';
import { ObservationScope } from '../lib/observation-scope';
import { mediaIdentity, type PlayerMetadata } from '../lib/adapters';
import type { PlaybackSession } from '../lib/types';
const page = 'https://www.youtube.com/watch?v=fixture';
const identity = mediaIdentity(page);
const source = (trackId: string) => ({
  identity,
  trackId,
  mime: 'audio/mp4',
  url: `https://cdn.googlevideo.com/videoplayback?id=${trackId}&itag=140`,
});
const metadata = (id: string): PlayerMetadata => ({
  identity,
  site: 'youtube',
  title: 'Fixture',
  ad: false,
  currentAudioTrackId: id,
  source: source(id),
  audioSources: [source(id)],
});
function fixture() {
  let current = metadata('en-original');
  let active: PlaybackSession | null = null;
  const handlers: Record<string, (details: any) => void> = {};
  const scope = new ObservationScope();
  scope.watch(7);
  const sources = new Map<number, SourceRecord>();
  const persisted: Record<string, any> = {};
  const stop = vi.fn(async () => {
    active = null;
  });
  const execute = vi.fn(async (): Promise<any> => [{ frameId: 0, result: current }]);
  const stats = { responses: 0, accepted: 0, lastError: '' };
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ url: page })) },
    scripting: { executeScript: execute },
    runtime: { sendMessage: vi.fn(async () => {}) },
    storage: {
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(persisted, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete persisted[key];
        }),
      },
    },
    webRequest: Object.fromEntries(
      ['onBeforeRequest', 'onBeforeSendHeaders', 'onResponseStarted', 'onErrorOccurred'].map(
        (name) => [
          name,
          {
            addListener: (handler: (details: any) => void) => {
              handlers[name] = handler;
            },
          },
        ],
      ),
    ),
  });
  registerMediaObserver({
    scope,
    sources,
    detected: new Map(),
    captureStats: stats,
    getSession: () => active,
    stop,
  });
  const observe = (id: string, track: string) => {
    const request = {
      requestId: id,
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: source(track).url,
      initiator: page,
    };
    handlers.onBeforeRequest!(request);
    handlers.onResponseStarted!({
      ...request,
      statusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'audio/mp4' }],
    });
  };
  return {
    sources,
    persisted,
    stop,
    stats,
    execute,
    observe,
    select: (track: string) => {
      current = metadata(track);
    },
    attach: (track: string) => {
      active = {
        id: 'session',
        candidate: { tabId: 7, mediaId: identity, pageId: identity, source: source(track) },
      } as PlaybackSession;
    },
  };
}
const flush = async () => {
  for (let at = 0; at < 8; at++) await new Promise<void>((resolve) => setImmediate(resolve));
};
afterEach(() => vi.unstubAllGlobals());
it('records distinct verified track IDs and stops the former native track on a direct-audio switch', async () => {
  const f = fixture();
  f.observe('first', 'en-original');
  await vi.waitFor(() => expect(f.sources.get(7)?.source.trackId).toBe('en-original'));
  f.attach('en-original');
  f.select('fr');
  f.observe('replacement', 'fr');
  await vi.waitFor(() => expect(f.sources.get(7)?.source.trackId).toBe('fr'));
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.persisted['source:7'].source.trackId).toBe('fr');
  expect(f.stats.lastError).toBe('');
});
it('ignores a former-track direct response after the native player selects a different track', async () => {
  const f = fixture();
  f.select('fr');
  f.observe('old-response', 'en-original');
  await flush();
  expect(f.sources.size).toBe(0);
  expect(f.persisted).toEqual({});
  expect(f.stats.lastError).toBe('');
});
it('does not let an unverified later response suppress a valid current-track response still awaiting metadata', async () => {
  const f = fixture();
  f.select('fr');
  let release!: (value: any) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.execute.mockImplementationOnce(() => pending);
  f.observe('valid-pending', 'fr');
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  f.observe('old-later', 'en-original');
  await flush();
  release([{ frameId: 0, result: metadata('fr') }]);
  await vi.waitFor(() => expect(f.sources.get(7)?.source.trackId).toBe('fr'));
  expect(f.stats.lastError).toBe('');
});
