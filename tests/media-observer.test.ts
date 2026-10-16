import { afterEach, expect, it, vi } from 'vitest';
import { registerMediaObserver, type DiscoveryRecord, type SourceRecord } from '../lib/media-observer';
import { ObservationScope } from '../lib/observation-scope';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const flush = async () => { for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve)); };
function fixture(page = 'https://fixture.example.org/watch') {
  const handlers: Record<string, (request: any) => void> = {};
  const sources = new Map<number, SourceRecord>(), detected = new Map<number, DiscoveryRecord>();
  const persisted: Record<string, any> = {};
  const scope = new ObservationScope();
  scope.watch(7);
  const read = deferred<Record<string, unknown>>();
  const write = deferred<void>();
  let holdWrites = false;
  const storage = {
    get: vi.fn(async () => read.promise),
    set: vi.fn(async (items: Record<string, unknown>) => { if (holdWrites) await write.promise; Object.assign(persisted, items); }),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete persisted[key]; }),
  };
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ url: page })) },
    storage: { session: storage },
    runtime: { sendMessage: vi.fn(async () => {}) },
    webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onResponseStarted', 'onErrorOccurred'].map((name) => [name, { addListener: (handler: (details: any) => void) => { handlers[name] = handler; } }])),
  });
  const stats = { responses: 0, accepted: 0, lastError: '' };
  registerMediaObserver({ scope, sources, detected, captureStats: stats, getSession: () => null, stop: async () => {} });
  const request = {
    requestId: 'late-request', tabId: 7, frameId: 0, method: 'GET',
    url: /(?:^|\.)bilibili\.com$/.test(new URL(page).hostname) ? 'https://cdn.bilivideo.com/audio.m4a' : 'https://cdn.example.org/audio.mp4',
    initiator: page,
  };
  const start = () => {
    handlers.onBeforeRequest!(request);
    handlers.onResponseStarted!({ ...request, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'audio/mp4' }] });
  };
  return { scope, sources, detected, persisted, storage, read, write, start, stats, holdWrites: () => { holdWrites = true; } };
}
afterEach(() => vi.unstubAllGlobals());
it.each(['release', 'navigate', 'release and watch again'] as const)('does not revive a late generic response after %s while its storage read is pending', async (action) => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.storage.get).toHaveBeenCalledOnce());
  if (action === 'navigate') f.scope.invalidate(7);
  else f.scope.release(7);
  if (action === 'release and watch again') f.scope.watch(7);
  f.detected.delete(7);
  f.read.resolve({});
  await flush();
  expect(f.detected.size).toBe(0);
  expect(f.sources.size).toBe(0);
  expect(f.persisted).toEqual({});
  expect(f.storage.set).not.toHaveBeenCalled();
  expect(f.stats.lastError).toBe('');
});
it.each([false, true])('removes a native response that finishes persisting after its lease is released (watchAgain=%s)', async (watchAgain) => {
  const f = fixture('https://www.bilibili.com/video/BVfixture/');
  f.holdWrites();
  f.start();
  await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalledOnce());
  f.scope.release(7);
  if (watchAgain) f.scope.watch(7);
  f.sources.delete(7);
  f.write.resolve();
  await flush();
  expect(f.sources.size).toBe(0);
  expect(f.persisted).toEqual({});
  expect(f.storage.remove).toHaveBeenCalledWith('source:7');
  expect(f.stats.lastError).toBe('');
});
