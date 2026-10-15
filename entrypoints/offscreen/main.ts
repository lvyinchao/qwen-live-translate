import DecodeWorker from '../../workers/decode?worker';
import { SegmentCache } from '../../lib/cache';
import { LocalFiles } from '../../lib/local-files';
import { archiveContext } from '../../lib/archive';
import { silenceBoundary } from '../../lib/audio';
import { coverageEnd, mergeCoverage, type Coverage } from '../../lib/timeline';
import { abortError, delay, translateWindow } from '../../lib/qwen';
import { endpoint } from '../../lib/security';
import {
  messageError,
  VOICE,
  type AudioSource,
  type Envelope,
  type PlaybackSession,
  type Result,
  type Settings,
  type TranslationSegment,
} from '../../lib/types';

const cache = new SegmentCache();
async function bg<T = unknown>(
  type: string,
  parameters: Record<string, unknown> = {},
): Promise<T> {
  const result = (await chrome.runtime.sendMessage({
    target: 'background',
    type,
    ...parameters,
  })) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const files = new LocalFiles(
  (url, filename) => bg<number>('files:download', { url, filename }),
  (status) => {
    void chrome.runtime
      .sendMessage({ type: 'files:updated', status })
      .catch(() => {});
  },
);
void files.flush().catch((error) => files.failed(error));
class Engine {
  session: PlaybackSession | null = null;
  settings: Settings | null = null;
  abort?: AbortController;
  worker?: Worker;
  ranges: Coverage[] = [];
  segments: TranslationSegment[] = [];
  startPosition = 0;
  private cacheIdentity() {
    const c = this.session!.candidate;
    return `${c.mediaId}|audio:${c.source?.trackId ?? 'default'}`;
  }
  private lastPublish = 0;
  private rebuffering = true;
  private userPaused = false;
  private decodeSerial = 0;
  private generation = 0;
  private connections = new Set<string>();
  private authQueue: Promise<unknown> = Promise.resolve();
  private auth<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.authQueue.then(operation);
    this.authQueue = next.catch(() => {});
    return next;
  }
  diagnostics = {
    startedAt: 0,
    firstReadyMs: 0,
    bufferCount: 0,
    inputSeconds: 0,
    outputSeconds: 0,
    usage: [] as unknown[],
    events: [] as Record<string, unknown>[],
  };
  async stop() {
    const savedContext = this.session
      ? archiveContext(this.session)
      : undefined;
    this.generation++;
    this.abort?.abort();
    this.worker?.terminate();
    this.worker = undefined;
    await files.flush().catch((error) => files.failed(error));
    if (savedContext)
      await files.finish(savedContext).catch((error) => files.failed(error));
    this.session = null;
    this.segments = [];
    this.ranges = [];
    this.settings = null;
    await bg('auth:remove').catch(() => {});
  }
  async start(session: PlaybackSession, settings: Settings) {
    await this.stop();
    this.session = session;
    this.settings = settings;
    this.diagnostics = {
      startedAt: Date.now(),
      firstReadyMs: 0,
      bufferCount: 0,
      inputSeconds: 0,
      outputSeconds: 0,
      usage: [],
      events: [],
    };
    this.startPosition = session.position;
    this.rebuffering = true;
    this.userPaused = false;
    await this.beginEpoch(session.position);
  }
  async publish(force = false) {
    if (!this.session) return;
    const now = performance.now();
    if (!force && now - this.lastPublish < 250) return;
    this.lastPublish = now;
    this.session.segments = this.segments.map(
      ({
        audio: _,
        audioDuration: __,
        mediaId: ___,
        language: ____,
        voice: _____,
        ...text
      }) => text,
    );
    await bg('engine:state', { session: this.session });
  }
  async sendSegment(segment: TranslationSegment, epoch: number) {
    if (!this.session || this.session.epoch !== epoch) return;
    await bg('engine:segment', { sessionId: this.session.id, epoch, segment });
  }
  async beginEpoch(position: number) {
    this.abort?.abort();
    this.worker?.terminate();
    if (!this.session) return;
    const session = this.session,
      operation = ++this.generation,
      epoch = ++session.epoch;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.rebuffering = true;
    session.position = position;
    session.phase = 'buffering';
    session.error = undefined;
    const identity = this.cacheIdentity();
    await files.flush().catch((error) => files.failed(error));
    if (
      signal.aborted ||
      operation !== this.generation ||
      this.session !== session
    )
      return;
    const cached = await cache.load(identity, session.language, VOICE);
    if (
      signal.aborted ||
      operation !== this.generation ||
      this.session !== session
    )
      return;
    this.ranges = cached.ranges;
    this.segments = cached.segments;
    // Save cache hits as well, grouped into bounded bundles. Exact repeats are
    // deduplicated against successfully completed downloads.
    const groups = new Map<number, TranslationSegment[]>();
    for (const segment of cached.segments) {
      const start = Math.floor(segment.start / 60) * 60;
      groups.set(start, [...(groups.get(start) ?? []), segment]);
    }
    for (const [start, segments] of groups) {
      await files.capture(
        archiveContext(session),
        start,
        Math.min(
          session.candidate.duration,
          Math.max(start + 60, ...segments.map((s) => s.end)),
        ),
        segments,
        true,
      );
      if (signal.aborted || operation !== this.generation) return;
    }
    this.startPosition = position;
    this.rebuffering = true;
    session.readyThrough = coverageEnd(this.ranges, position);
    session.inputThrough = session.readyThrough;
    if (session.readyThrough > position + 3) {
      this.rebuffering = false;
      session.phase = this.userPaused ? 'paused' : 'playing';
    }
    // New epoch starts only after the previous connection's auth cleanup.
    await bg('auth:remove').catch(() => {});
    if (signal.aborted || operation !== this.generation) return;
    this.worker = new DecodeWorker();
    await this.publish(true);
    for (const segment of this.segments.filter(
      (s) => s.end > position && s.start < position + 90,
    ))
      await this.sendSegment(segment, epoch);
    this.updateReadiness();
    void this.produce(epoch, signal).catch(async (error) => {
      if (signal.aborted || !this.session || this.session.epoch !== epoch)
        return;
      this.worker?.terminate();
      this.worker = undefined;
      this.abort?.abort();
      this.session.phase = 'error';
      this.session.error = messageError(error);
      await files.flush().catch((failure) => files.failed(failure));
      await files
        .finish(archiveContext(session))
        .catch((failure) => files.failed(failure));
      await this.publish(true);
    });
  }
  async decode(
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<Float32Array> {
    const worker = this.worker;
    const source = await bg<AudioSource | undefined>('media:refresh', {
      sessionId: this.session?.id,
      epoch: this.session?.epoch,
    });
    signal.throwIfAborted();
    if (source && this.session) this.session.candidate.source = source;
    if (!worker || !source) throw new Error('没有可预取的音轨');
    await bg('media:headers', { source });
    const id = String(++this.decodeSerial);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', listener);
        signal.removeEventListener('abort', abort);
        clearTimeout(timer);
      };
      const abort = () => {
        cleanup();
        reject(abortError());
      };
      const listener = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        cleanup();
        if (event.data.ok) resolve(new Float32Array(event.data.samples));
        else {
          if (event.data.diagnostics)
            this.diagnostics.events.push({
              type: 'decode-error',
              at: Date.now(),
              windows: event.data.diagnostics,
            });
          reject(new Error(event.data.error));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('音轨读取超时，请刷新视频后重新扫描'));
      }, 60000);
      worker.addEventListener('message', listener);
      signal.addEventListener('abort', abort, { once: true });
      worker.postMessage({ id, type: 'decode', source, start, end });
    });
  }
  updateReadiness() {
    const s = this.session;
    if (!s || s.phase === 'error') return;
    s.readyThrough = coverageEnd(this.ranges, s.position);
    const ready = s.readyThrough - s.position;
    const tail = s.candidate.duration - s.position;
    if (this.rebuffering && ready >= Math.min(30, tail) - 0.08) {
      this.rebuffering = false;
      s.phase = this.userPaused ? 'paused' : 'playing';
      if (!this.diagnostics.firstReadyMs)
        this.diagnostics.firstReadyMs = Date.now() - this.diagnostics.startedAt;
    } else if (!this.rebuffering && ready < 0.15 && tail > 0.15) {
      this.rebuffering = true;
      s.phase = 'buffering';
      this.diagnostics.bufferCount++;
    } else if (this.rebuffering) s.phase = 'buffering';
  }
  async produce(epoch: number, signal: AbortSignal) {
    let cursor = this.session!.position;
    while (!signal.aborted && this.session?.epoch === epoch) {
      const s = this.session;
      if (cursor >= s.candidate.duration - 0.02) {
        await files.finish(archiveContext(s));
        return;
      }
      const existing = coverageEnd(this.ranges, cursor);
      if (existing > cursor + 0.02) {
        cursor = existing;
        continue;
      }
      while (cursor - this.session.position >= 60) {
        await delay(250, signal);
      }
      if (signal.aborted || this.session?.epoch !== epoch) return;
      const size = cursor === this.startPosition ? 30 : 60;
      const maximumEnd = Math.min(
        cursor + size,
        s.position + 90,
        s.candidate.duration,
      );
      const decoded = await this.decode(cursor, maximumEnd, signal);
      const cut =
        maximumEnd < s.candidate.duration
          ? silenceBoundary(decoded, size)
          : decoded.length;
      // A 30 second initial window must cover the 30 second startup target.
      const samples =
        size === 30 ? decoded : decoded.slice(0, Math.max(16000, cut));
      const end = cursor + samples.length / 16000;
      const windows = [{ start: 0, end: samples.length }];
      let next = 0;
      const translatePart = async (part: { start: number; end: number }) => {
        const windowStart = cursor + part.start / 16000,
          windowEnd = cursor + part.end / 16000;
        const context = archiveContext(s);
        let lastInput = windowStart,
          attemptStart = windowStart;
        const connection = crypto.randomUUID();
        let providerSession = connection;
        const emit = (segment: TranslationSegment) => {
          if (signal.aborted || this.session?.epoch !== epoch) return;
          this.segments = this.segments.filter(
            (s) =>
              !(
                Math.abs(s.start - segment.start) < 0.05 &&
                Math.abs(s.end - segment.end) < 0.05
              ),
          );
          this.segments.push(segment);
          this.segments.sort((a, b) => a.start - b.start);
          this.diagnostics.outputSeconds += segment.audioDuration;
          void this.sendSegment(segment, epoch);
          void files
            .capture(context, windowStart, windowEnd, [segment])
            .catch((error) => files.failed(error));
        };
        let result: TranslationSegment[] = [];
        for (let attempt = 0; ; attempt++) {
          try {
            result = await translateWindow({
              url: endpoint(this.settings!),
              mediaId: s.candidate.mediaId,
              language: s.language,
              start: attemptStart,
              samples: samples.subarray(
                part.start + Math.round((attemptStart - windowStart) * 16000),
                part.end,
              ),
              signal,
              beforeConnect: () =>
                this.auth(async () => {
                  signal.throwIfAborted();
                  this.connections.add(connection);
                  try {
                    await bg('auth:install', { sessionId: s.id, epoch });
                  } catch (error) {
                    this.connections.delete(connection);
                    throw error;
                  }
                }),
              afterClose: () =>
                this.auth(async () => {
                  this.connections.delete(connection);
                  if (!this.connections.size) await bg('auth:remove');
                }),
              onSegment: emit,
              onEvent: (event) => {
                if (event.type === 'session.created')
                  providerSession = event.session?.id ?? crypto.randomUUID();
                if (event.type === 'response.done' && event.response?.usage)
                  this.diagnostics.usage.push({
                    ...event.response.usage,
                    providerSession,
                  });
              },
              waitForHeadroom: async (position) => {
                while (
                  this.session?.epoch === epoch &&
                  position - this.session.position >= 90
                )
                  await delay(250, signal);
              },
              onProgress: (inputThrough, ready) => {
                if (signal.aborted || this.session?.epoch !== epoch) return;
                this.session.inputThrough = Math.max(
                  this.session.inputThrough,
                  inputThrough,
                );
                this.diagnostics.inputSeconds += Math.max(
                  0,
                  inputThrough - lastInput,
                );
                lastInput = inputThrough;

                if (ready > attemptStart)
                  this.ranges = mergeCoverage([
                    ...this.ranges,
                    { start: attemptStart, end: ready },
                  ]);
                this.updateReadiness();
                void this.publish();
              },
            });
            break;
          } catch (error) {
            if (
              signal.aborted ||
              attempt >= 2 ||
              !/提前断开|连接失败|限流|超时/.test(messageError(error))
            )
              throw error;
            this.diagnostics.events.push({
              type: 'retry',
              at: Date.now(),
              windowStart,
              attempt: attempt + 1,
              error: messageError(error),
            });
            attemptStart = coverageEnd(this.ranges, windowStart);
            lastInput = attemptStart;
            if (attemptStart >= windowEnd - 0.02) break;
            await delay(1000 * 2 ** attempt, signal);
          }
        }
        if (signal.aborted || this.session?.epoch !== epoch) return;

        this.ranges = mergeCoverage([
          ...this.ranges,
          { start: windowStart, end: windowEnd },
        ]);
        const completedSegments = this.segments.filter(
          (t) => t.start >= windowStart - 0.03 && t.end <= windowEnd + 0.03,
        );
        await cache.put(
          this.cacheIdentity(),
          s.language,
          VOICE,
          { start: windowStart, end: windowEnd },
          completedSegments,
        );
        await files.capture(
          context,
          windowStart,
          windowEnd,
          completedSegments,
          true,
        );
        if (signal.aborted || this.session?.epoch !== epoch) return;
        this.updateReadiness();
        await this.publish(true);
      };
      const lane = async () => {
        while (
          next < windows.length &&
          !signal.aborted &&
          this.session?.epoch === epoch
        ) {
          const part = windows[next++]!;
          await translatePart(part);
        }
      };
      await lane();
      if (signal.aborted || this.session?.epoch !== epoch) return;
      cursor = end;
      // Keep active memory bounded independently from persistent LRU storage.
      this.segments = this.segments.filter(
        (t) => t.end > this.session!.position - 300,
      );
    }
  }
  async clock(message: Envelope) {
    const s = this.session;
    if (!s || message.sessionId !== s.id) return;
    if (message.type !== 'player:seek' && message.epoch !== s.epoch) return;
    if (message.type === 'player:seek') {
      this.userPaused = Boolean(message.paused);
      await this.beginEpoch(Number(message.position));
      return;
    }
    if (message.type === 'player:skip' || message.type === 'player:metric') {
      const { target: _, type, sessionId: __, ...event } = message;
      this.diagnostics.events.push({
        ...event,
        type,
        epoch: s.epoch,
        at: Date.now(),
      });
      if (this.diagnostics.events.length > 5000)
        this.diagnostics.events.shift();
      if (message.type === 'player:skip') {
        s.skipped++;
        const segment = this.segments.find((t) => t.id === message.segmentId);
        if (segment) segment.skipped = true;
        await this.publish(true);
      }
      return;
    }
    s.position = Number(message.position);
    s.rate = Number(message.rate);
    if (message.userPaused !== undefined)
      this.userPaused = Boolean(message.userPaused);
    if (message.ended) {
      s.phase = 'ended';
      await files
        .finish(archiveContext(s))
        .catch((error) => files.failed(error));
    } else if (!this.rebuffering && s.phase !== 'error')
      s.phase = this.userPaused ? 'paused' : 'playing';
    this.updateReadiness();
    await this.publish();
  }
}
const engine = new Engine();
chrome.runtime.onMessage.addListener((message: Envelope, sender, respond) => {
  if (
    message.target !== 'offscreen' ||
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(''))
  )
    return;
  void (async () => {
    if (message.type === 'engine:start') {
      await engine.start(
        message.session as PlaybackSession,
        message.settings as Settings,
      );
      return true;
    }
    if (message.type === 'engine:mix') {
      const current = engine.session;
      if (current && current.id === message.sessionId)
        Object.assign(current, {
          originalVolume: Number(message.originalVolume),
          dubVolume: Number(message.dubVolume),
          subtitles: Boolean(message.subtitles),
        });
      return true;
    }
    if (message.type === 'engine:stop') {
      await engine.stop();
      return true;
    }
    if (message.type === 'cache:clear') {
      await cache.clear();
      return true;
    }
    if (message.type === 'files:status') return files.status();
    if (message.type === 'files:merge') {
      await files.finish(
        engine.session ? archiveContext(engine.session) : undefined,
      );
      return files.status();
    }
    if (message.type === 'files:retry') {
      await files.retry();
      return files.status();
    }
    if (message.type === 'engine:diagnostics') {
      const memory = (
        performance as unknown as {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory;
      return {
        ...engine.diagnostics,
        cacheBytes: await cache.size(),
        heap: memory
          ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize }
          : undefined,
      };
    }
    if (message.type === 'engine:probe') {
      const settings = message.settings as Settings;
      await translateWindow({
        url: endpoint(settings),
        mediaId: 'connection-test',
        language: settings.language,
        start: 0,
        samples: new Float32Array(4800),
        signal: new AbortController().signal,
        beforeConnect: async () => {
          await bg('auth:install');
        },
        afterClose: async () => {
          await bg('auth:remove');
        },
        onSegment: () => {},
        onProgress: () => {},
      });
      return '已连接 Qwen3.8 LiveTranslate';
    }
    if (message.type.startsWith('player:')) {
      await engine.clock(message);
      return true;
    }
    return false;
  })().then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: messageError(error) }),
  );
  return true;
});
