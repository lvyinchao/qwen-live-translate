import { afterEach, expect, it, vi } from 'vitest';
import { PlaybackEngine, type EngineDependencies } from '../lib/playback-engine';
import { createBackgroundRpc } from '../lib/background-rpc';
import type { BackgroundCall } from '../lib/messages';
import { AppError } from '../lib/errors';
import { bufferPolicy, preparationStatus } from '../lib/preparation';
import type { TranslateWindowOptions } from '../lib/qwen';
import { DEFAULT_SETTINGS, VOICE, type PlaybackSession, type TranslationSegment } from '../lib/types';

const pending = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const source = { url: 'https://cdn.bilivideo.com/audio.mp4', identity: 'bilibili:fixture', trackId: 'track' };
const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-not-real', workspace: 'test-workspace' };
const session = (overrides: Partial<PlaybackSession> = {}): PlaybackSession => ({
  id: 'session', epoch: 0, languageVersion: 0,
  candidate: { id: 'video', mediaId: 'bilibili:fixture', tabId: 1, frameId: 0,
    site: 'bilibili', title: 'Fixture', poster: '', duration: 300, currentTime: 0,
    width: 640, height: 360, paused: false, ad: false, sourceStatus: 'ready', source },
  language: 'zh', phase: 'preparing', position: 0, rate: 1, readyThrough: 0,
  inputThrough: 0, skipped: 0, originalVolume: 0, dubVolume: 1, subtitles: true,
  segments: [], ...overrides,
});
const segment = (start: number, language = 'zh', speaker?: number): TranslationSegment => ({
  id: `${language}:${start}:${speaker ?? 'default'}`, start, end: start + 3,
  language, mediaId: 'bilibili:fixture', voice: VOICE, audio: 'AAA=', audioDuration: 2,
  sourceText: 'hello', text: `translation ${language}`, speaker,
});
class Decoder extends EventTarget {
  terminate = vi.fn();
  postMessage(message: { type: string; id: string; start: number; end: number }) {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: { id: message.id, ok: true, samples: new Float32Array(Math.round((message.end - message.start) * 16000)).buffer },
    })));
  }
}
function fixture(options: {
  load?: EngineDependencies['cache']['load'];
  send?: (type: string, parameters: Record<string, unknown>) => Promise<unknown>;
  flush?: () => Promise<void>;
  translate?: EngineDependencies['translate'];
  now?: () => number;
  sleep?: EngineDependencies['sleep'];
} = {}) {
  const calls: { type: string; parameters: Record<string, unknown> }[] = [];
  const cache = { load: vi.fn(options.load ?? (async (_id, language) => ({
    ranges: [{ start: 0, end: 300 }], segments: [5, 95, 195, 275].map((at) => segment(at, language)),
  }))), put: vi.fn(async () => {}) };
  const files = { flush: vi.fn(options.flush ?? (async () => {})), finish: vi.fn(async () => {}),
    capture: vi.fn(async () => {}), failed: vi.fn(async () => {}) };
  const translate = vi.fn(options.translate ?? (async () => []));
  const workers: Decoder[] = [];
  const engine = new PlaybackEngine({
    cache, files, translate, now: options.now, sleep: options.sleep,
    createWorker: () => { const worker = new Decoder(); workers.push(worker); return worker as unknown as Worker; },
    background: (async (type: string, parameters: Record<string, unknown> = {}) => {
      calls.push({ type, parameters: structuredClone(parameters) });
      if (options.send) return await options.send(type, parameters);
      return type === 'media:refresh' ? source : true;
    }) as BackgroundCall,
  });
  const clock = async (position: number, extra: Record<string, unknown> = {}) => engine.clock({
    type: 'player:clock', sessionId: engine.session!.id, epoch: engine.session!.epoch,
    languageVersion: engine.session!.languageVersion ?? 0, position, rate: engine.session!.rate,
    userPaused: false, ...extra,
  });
  const deliveries = () => calls.filter((call) => call.type === 'engine:segment')
    .map((call) => call.parameters.segment as TranslationSegment);
  return { engine, cache, files, translate, calls, clock, deliveries, workers };
}
afterEach(() => vi.restoreAllMocks());

it('delivers cached utterances as the clock advances beyond the initial 90 seconds', async () => {
  const f = fixture();
  await f.engine.start(session(), settings);
  expect(f.deliveries().map((s) => s.start)).toEqual([5]);
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 90 });
  await f.clock(20);
  await f.clock(110);
  await f.clock(200);
  expect(f.deliveries().map((s) => s.start)).toEqual([5, 95, 195, 275]);
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 290 });
  expect(f.translate).not.toHaveBeenCalled();
  expect(f.workers).toHaveLength(0);
});

it('reloads and delivers a cached seek without accepting old-epoch audio', async () => {
  const f = fixture();
  await f.engine.start(session(), settings);
  const oldEpoch = f.engine.session!.epoch;
  await f.clock(190, { type: 'player:seek', paused: false });
  expect(f.engine.session).toMatchObject({ epoch: oldEpoch + 1, position: 190, phase: 'playing' });
  expect(f.deliveries().slice(1).map((s) => s.start)).toEqual([195, 275]);
  const deliveries = f.deliveries().length;
  await f.clock(10, { epoch: oldEpoch });
  expect(f.engine.session!.position).toBe(190);
  expect(f.deliveries()).toHaveLength(deliveries);
});

it('assigns increasing immutable versions to snapshots so late transport retries can be rejected', async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  await f.engine.start(session(), settings);
  now += 1000;
  await f.clock(20);
  now += 1000;
  await f.clock(30);
  const snapshots = f.calls.filter((call) => call.type === 'engine:state')
    .map((call) => call.parameters.session as PlaybackSession);
  expect(snapshots.length).toBeGreaterThan(2);
  for (let index = 1; index < snapshots.length; index++)
    expect(snapshots[index]!.stateVersion).toBeGreaterThan(snapshots[index - 1]!.stateVersion!);
  expect(snapshots[0]).toMatchObject({ position: 0, stateVersion: 1 });
  expect(snapshots.at(-1)).toMatchObject({ position: 30 });
});

it('switches back to a cached language and isolates the previous language revision', async () => {
  const f = fixture();
  await f.engine.start(session(), settings);
  const initial = { ...f.engine.session! };
  await f.engine.switchLanguage({ ...initial, language: 'ja', languageVersion: 1, epoch: initial.epoch + 1 }, false);
  const japanese = { ...f.engine.session! };
  await f.engine.switchLanguage({ ...japanese, language: 'zh', languageVersion: 2, epoch: japanese.epoch + 1 }, false);
  expect(f.deliveries().map((s) => s.language)).toEqual(['zh', 'ja', 'zh']);
  await f.clock(100, { languageVersion: 0, epoch: initial.epoch });
  await f.clock(100, { languageVersion: 1, epoch: japanese.epoch });
  expect(f.engine.session).toMatchObject({ language: 'zh', languageVersion: 2, position: 0 });
  expect(f.translate).not.toHaveBeenCalled();
});

it('does not advertise readiness until all relevant audio deliveries are acknowledged', async () => {
  const ack = pending<boolean>();
  const f = fixture({ send: async (type) => type === 'engine:segment' ? ack.promise : true });
  const start = f.engine.start(session(), settings);
  await settle();
  expect(f.engine.session).toMatchObject({ phase: 'buffering', readyThrough: 0 });
  ack.resolve(true);
  await start;
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 90 });
});

it('fails explicitly when the selected player rejects an utterance', async () => {
  const f = fixture({ send: async (type) => type !== 'engine:segment' });
  await expect(f.engine.start(session(), settings)).rejects.toThrow('播放器未接收译音');
  expect(f.engine.session).toMatchObject({ phase: 'error', readyThrough: 0 });
});

it('delivers silent cached coverage without inventing speech', async () => {
  const f = fixture({ load: async () => ({ ranges: [{ start: 0, end: 300 }], segments: [] }) });
  await f.engine.start(session(), settings);
  await f.clock(150);
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 240 });
  expect(f.deliveries()).toEqual([]);
});

it('never bridges an untranslated gap when cache ranges are disconnected', async () => {
  const f = fixture({ load: async () => ({ ranges: [{ start: 0, end: 10 }, { start: 30, end: 300 }],
    segments: [segment(5), segment(35)] }),
    send: async (type) => type === 'media:refresh' ? new Promise(() => {}) : true });
  await f.engine.start(session(), settings);
  expect(f.engine.session).toMatchObject({ phase: 'buffering', readyThrough: 10 });
  expect(f.deliveries().map((s) => s.start)).toEqual([5]);
  await f.engine.stop();
});

it('clears a stopped task immediately and does not wait for slow file export', async () => {
  const disk = pending<void>();
  const f = fixture({ flush: () => disk.promise });
  await f.engine.start(session(), settings);
  const stop = f.engine.stop('session');
  expect(f.engine.session).toBeNull();
  const start = f.engine.start(session({ id: 'new-session' }), settings);
  await Promise.all([stop, start]);
  expect(f.engine.session?.id).toBe('new-session');
  disk.resolve();
  await settle();
  expect(f.engine.session?.id).toBe('new-session');
});

it('ignores a stale stop for a different session', async () => {
  const f = fixture();
  await f.engine.start(session({ id: 'new-session' }), settings);
  expect(await f.engine.stop('old-session')).toBe(false);
  expect(f.engine.session?.id).toBe('new-session');
});

it('latest start wins when an older cache load finishes late', async () => {
  const oldLoad = pending<{ ranges: { start: number; end: number }[]; segments: TranslationSegment[] }>();
  let calls = 0;
  const f = fixture({ load: async () => ++calls === 1 ? oldLoad.promise : {
    ranges: [{ start: 0, end: 300 }], segments: [segment(5)],
  } });
  const first = f.engine.start(session({ id: 'old' }), settings);
  await settle();
  const next = f.engine.start(session({ id: 'new' }), settings);
  oldLoad.resolve({ ranges: [{ start: 0, end: 300 }], segments: [segment(45)] });
  await Promise.all([first, next]);
  expect(f.engine.session?.id).toBe('new');
  expect(f.deliveries().map((s) => s.start)).toEqual([5]);
  expect(f.calls.filter((call) => call.type === 'engine:state')
    .every((call) => (call.parameters.session as PlaybackSession).id === 'new')).toBe(true);
});

it('a stop supersedes queued setup and no late cache state is published', async () => {
  const load = pending<{ ranges: { start: number; end: number }[]; segments: TranslationSegment[] }>();
  const f = fixture({ load: () => load.promise });
  const start = f.engine.start(session(), settings);
  await settle();
  const stop = f.engine.stop('session');
  load.resolve({ ranges: [{ start: 0, end: 300 }], segments: [segment(5)] });
  await Promise.all([start, stop]);
  expect(f.engine.session).toBeNull();
  expect(f.deliveries()).toEqual([]);
});

it('scales startup and maintenance buffer for faster video while retaining the 90-second cap', () => {
  expect(bufferPolicy(0.5)).toMatchObject({ startupTargetSeconds: 30, maintainTargetSeconds: 60 });
  expect(bufferPolicy(1.5)).toMatchObject({ startupTargetSeconds: 45, maintainTargetSeconds: 90 });
  expect(bufferPolicy(2)).toMatchObject({ startupTargetSeconds: 60, maintainTargetSeconds: 90, maxAheadSeconds: 90 });
  expect(bufferPolicy(NaN).videoRate).toBe(1);
});

it('does not start 2× playback from only 30 seconds of cache', async () => {
  const f = fixture({ load: async () => ({ ranges: [{ start: 0, end: 30 }], segments: [segment(5)] }),
    send: async (type) => type === 'media:refresh' ? new Promise(() => {}) : true });
  await f.engine.start(session({ rate: 2 }), settings);
  expect(f.engine.session).toMatchObject({ phase: 'buffering', readyThrough: 30,
    preparation: { startupTargetSeconds: 60, maintainTargetSeconds: 90, limitedByRealtimeInput: true } });
  await f.engine.stop();
});

it('prepares only the remaining tail when it is shorter than the rate-adjusted startup target', async () => {
  const f = fixture();
  await f.engine.start(session({ rate: 2, position: 280 }), settings);
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 300 });
});

it('reports prepared throughput separately from input throughput and admits buffer depletion', () => {
  expect(preparationStatus(1.5, 30, 24, 32)).toMatchObject({
    inputRealtimeFactor: 0.9375, preparedRealtimeFactor: 0.75,
    netBufferSecondsPerSecond: -0.75, limitedByRealtimeInput: true,
  });
  expect(Number.isFinite(preparationStatus(1, 0, 0, 0).inputRealtimeFactor)).toBe(true);
});

it('ignores late provider segments, progress and errors after a language switch', async () => {
  let provider!: TranslateWindowOptions;
  const f = fixture({
    load: async (_id, language) => language === 'zh' ? { ranges: [], segments: [] } : {
      ranges: [{ start: 0, end: 300 }], segments: [segment(5, language)],
    },
    translate: async (options) => {
      provider = options;
      await options.beforeConnect();
      try {
        await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
      } finally { await options.afterClose(); }
      return [];
    },
  });
  await f.engine.start(session(), settings);
  await settle();
  expect(provider).toBeDefined();
  const old = { ...f.engine.session! };
  await f.engine.switchLanguage({ ...old, language: 'ja', languageVersion: 1, epoch: old.epoch + 1 }, false);
  provider.onSegment(segment(1));
  provider.onProgress(300, 300);
  expect(f.engine.session).toMatchObject({ language: 'ja', phase: 'playing', inputThrough: 300 });
  expect(f.deliveries().map((s) => s.language)).toEqual(['ja']);
  expect(f.calls.filter((call) => call.type === 'engine:state')
    .some((call) => (call.parameters.session as PlaybackSession).phase === 'error')).toBe(false);
});

it('cleans the old provider authentication before starting the replacement connection', async () => {
  const cleanup = pending<void>();
  let count = 0;
  const order: string[] = [];
  const f = fixture({ load: async () => ({ ranges: [], segments: [] }),
    translate: async (options) => {
      const index = ++count;
      await options.beforeConnect();
      order.push(`connected-${index}`);
      try {
        await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
      } finally {
        if (index === 1) await cleanup.promise;
        await options.afterClose();
        order.push(`cleaned-${index}`);
      }
      return [];
    },
  });
  await f.engine.start(session(), settings);
  await settle();
  const replacement = f.engine.start(session({ id: 'replacement' }), settings);
  await settle();
  expect(order).toEqual(['connected-1']);
  cleanup.resolve();
  await replacement;
  await settle();
  expect(order.slice(0, 3)).toEqual(['connected-1', 'cleaned-1', 'connected-2']);
  await f.engine.stop();
});

it('records end-to-end preparation wall time and completed coverage rather than model-input arrival alone', async () => {
  let now = 0;
  const f = fixture({ now: () => now, load: async () => ({ ranges: [], segments: [] }),
    translate: async (options) => {
      await options.beforeConnect();
      now = 34000;
      options.onSegment(segment(5));
      options.onProgress(30, 30);
      await options.afterClose();
      return [segment(5)];
    },
  });
  const choice = session();
  choice.candidate.duration = 30;
  await f.engine.start(choice, settings);
  await settle();
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 30 });
  expect(f.engine.diagnostics).toMatchObject({ inputSeconds: 30, preparedSeconds: 30, preparationWallSeconds: 34 });
  expect(f.engine.preparation()?.preparedRealtimeFactor).toBeCloseTo(30 / 34);
  expect(f.engine.preparation()?.netBufferSecondsPerSecond).toBeCloseTo(30 / 34 - 1);
  await f.engine.stop();
  expect(f.engine.preparation()?.preparedRealtimeFactor).toBeCloseTo(30 / 34);
});

it('does not spawn a late decoder after cancellation while media headers were pending', async () => {
  const headers = pending<boolean>();
  let headerRequested = false;
  const f = fixture({ load: async (_id, language) => language === 'zh' ? { ranges: [], segments: [] } : {
    ranges: [{ start: 0, end: 300 }], segments: [segment(5, language)],
  }, send: async (type) => {
    if (type === 'media:refresh') return source;
    if (type === 'media:headers') { headerRequested = true; return headers.promise; }
    return true;
  } });
  await f.engine.start(session(), settings);
  await settle();
  expect(headerRequested).toBe(true);
  const previous = f.engine.session!;
  await f.engine.switchLanguage({ ...previous, language: 'ja', languageVersion: 1, epoch: previous.epoch + 1 }, false);
  headers.resolve(true);
  await settle();
  expect(f.workers).toHaveLength(0);
  expect(f.engine.session).toMatchObject({ language: 'ja', phase: 'playing' });
  expect(f.translate).not.toHaveBeenCalled();
});

it('fills only the missing cache hole without translating or duplicating the cached suffix', async () => {
  const starts: number[] = [];
  const f = fixture({ load: async () => ({ ranges: [{ start: 0, end: 10 }, { start: 30, end: 300 }],
    segments: [segment(5), segment(35)] }), translate: async (options) => {
      starts.push(options.start);
      expect(options.samples.length / 16000).toBe(20);
      await options.beforeConnect();
      options.onSegment(segment(20));
      options.onProgress(30, 30);
      await options.afterClose();
      return [segment(20)];
    },
  });
  await f.engine.start(session(), settings);
  await settle();
  expect(starts).toEqual([10]);
  expect(f.deliveries().filter((s) => s.start === 35)).toHaveLength(1);
  expect(f.cache.put).toHaveBeenCalledWith(expect.any(String), 'zh', VOICE,
    { start: 10, end: 30 }, [expect.objectContaining({ start: 20 })]);
});

it('retires the decoder and cancels a live provider at natural video end', async () => {
  let options!: TranslateWindowOptions;
  const f = fixture({ load: async () => ({ ranges: [], segments: [] }), translate: async (value) => {
    options = value;
    await value.beforeConnect();
    try {
      await new Promise<void>((_resolve, reject) => value.signal.addEventListener('abort',
        () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    } finally { await value.afterClose(); }
    return [];
  } });
  await f.engine.start(session(), settings);
  await settle();
  expect(f.workers).toHaveLength(1);
  await f.clock(300, { ended: true });
  await settle();
  expect(options.signal.aborted).toBe(true);
  expect(f.workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(f.engine.session?.phase).toBe('ended');
  const finished = f.files.finish.mock.calls.length;
  await f.clock(300, { ended: true });
  await settle();
  expect(f.files.finish).toHaveBeenCalledTimes(finished);
  options.onSegment(segment(5));
  expect(f.deliveries()).toEqual([]);
});

it('keeps a completed first window alive when MV3 restart interrupts provider authentication cleanup', async () => {
  let removals = 0;
  const rpc = createBackgroundRpc(async (message) => {
    if (message.type === 'auth:remove' && ++removals === 2)
      throw new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received');
    return { ok: true, value: message.type === 'media:refresh' ? source : true };
  }, async () => {});
  const f = fixture({ load: async () => ({ ranges: [], segments: [] }), send: rpc as never,
    translate: async (options) => {
      await options.beforeConnect();
      options.onEvent?.({ type: 'session.updated', session: { enable_voice_clone: true, voice_clone_options: { frequency: 'always' } } });
      options.onSegment(segment(5));
      options.onProgress(30, 30);
      await options.afterClose();
      return [segment(5)];
    },
  });
  const choice = session(); choice.candidate.duration = 30;
  await f.engine.start(choice, settings);
  await settle();
  expect(removals).toBe(3);
  expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 30 });
  expect(f.cache.put).toHaveBeenCalledOnce();
  expect(f.engine.diagnostics.events).toContainEqual(expect.objectContaining({ type: 'provider:voice-confirmed', frequency: 'always' }));
  expect(f.calls.some((call) => call.type === 'engine:state' && (call.parameters.session as PlaybackSession).phase === 'error')).toBe(false);
});

const terminal = (sessionId: string, epoch: number, languageVersion = 0) => ({
  type: 'player:metric', kind: 'terminal', sessionId, epoch, languageVersion,
  segmentId: 'utterance', reason: 'seek-stop', remaining: 0.06, audioTime: 0.74, sourceTime: 2,
});
it('deduplicates terminal delivery across the normal channel and lifecycle response, retaining known old revisions', async () => {
  const f = fixture();
  await f.engine.start(session(), settings);
  const epoch = f.engine.session!.epoch;
  const event = terminal('session', epoch);
  await f.engine.clock(event);
  expect(f.engine.recordTerminals({ type: 'engine:terminals', sessionId: 'session', events: [event] })).toBe(true);
  expect(f.engine.diagnostics.events.filter((entry) => entry.kind === 'terminal')).toHaveLength(1);
  const old = { ...f.engine.session! };
  await f.engine.switchLanguage({ ...old, language: 'ja', epoch: epoch + 1, languageVersion: 1 }, false);
  const oldLate = { ...event, segmentId: 'old-late' };
  f.engine.recordTerminals({ type: 'engine:terminals', sessionId: 'session', events: [oldLate,
    terminal('session', 100), terminal('session', epoch + 1, 99), terminal('other', epoch)] });
  expect(f.engine.diagnostics.events.filter((entry) => entry.kind === 'terminal')).toHaveLength(2);
});
it('rejects terminal records after stop or from a replaced task without polluting new diagnostics', async () => {
  const f = fixture();
  await f.engine.start(session(), settings);
  const event = terminal('session', f.engine.session!.epoch);
  await f.engine.stop();
  expect(f.engine.recordTerminals({ type: 'engine:terminals', sessionId: 'session', events: [event] })).toBe(false);
  await f.engine.start(session({ id: 'new-task' }), settings);
  await f.engine.clock(event);
  expect(f.engine.recordTerminals({ type: 'engine:terminals', sessionId: 'new-task', events: [event] })).toBe(true);
  expect(f.engine.diagnostics.events).toEqual([]);
});
it('bounds verbose frontend stages separately so they cannot evict onset, completion or voice evidence', async () => {
  const f = fixture();
  await f.engine.start(session(), settings);
  const common = { type: 'player:metric', sessionId: 'session', epoch: f.engine.session!.epoch,
    languageVersion: 0, segmentId: 'utterance' };
  f.engine.diagnostics.events.push({ type: 'provider:voice-confirmed', providerSession: 'test' });
  await f.engine.clock({ ...common, kind: 'start' });
  for (let index = 0; index < 5500; index++)
    await f.engine.clock({ ...common, kind: 'audio-stage', stage: 'play-call', frontendAt: index });
  await f.engine.clock({ ...common, kind: 'end' });
  await f.engine.clock(terminal('session', f.engine.session!.epoch));
  expect(f.engine.diagnostics.debugEvents).toHaveLength(1000);
  expect(f.engine.diagnostics.droppedDebugEvents).toBe(4500);
  expect(f.engine.diagnostics.droppedCriticalEvents).toBe(0);
  expect(f.engine.diagnostics.events.map((entry) => entry.kind ?? entry.type))
    .toEqual(['provider:voice-confirmed', 'start', 'end', 'terminal']);
});

it.each([
  ['retries a coded transient provider failure', new AppError('provider-disconnected', '翻译连接提前断开（1006），本段未标记为完成'), 2],
  ['does not retry an uncoded failure whose text merely resembles one', new Error('翻译连接提前断开（1006），本段未标记为完成'), 1],
  ['does not retry a coded permanent provider failure', new AppError('provider-voice-clone', '模型未确认启用原音色复刻，已停止翻译'), 1],
])('%s', async (_name, failure, attempts) => {
  let calls = 0;
  const sleep = vi.fn(async () => {});
  const f = fixture({ sleep, load: async () => ({ ranges: [], segments: [] }),
    translate: async (options) => {
      if (++calls === 1) throw failure;
      await options.beforeConnect();
      options.onSegment(segment(5));
      options.onProgress(30, 30);
      await options.afterClose();
      return [segment(5)];
    },
  });
  const choice = session();
  choice.candidate.duration = 30;
  await f.engine.start(choice, settings).catch(() => {});
  await settle();
  expect(calls).toBe(attempts);
  if (attempts > 1) expect(f.engine.session).toMatchObject({ phase: 'playing', readyThrough: 30 });
  else expect(f.engine.session?.phase ?? 'error').toBe('error');
});
