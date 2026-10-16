import type { SegmentCache } from './cache';
import type { LocalFiles } from './local-files';
import { archiveContext, sameArchiveUtterance, type ArchiveContext } from './archive';
import { silenceBoundary } from './audio';
import { coverageEnd, mergeCoverage, type Coverage } from './timeline';
import { abortError, delay, translateWindow } from './qwen';
import { endpoint } from './security';
import { bufferPolicy, preparationStatus } from './preparation';
import {
  messageError,
  VOICE,
  type AudioSource,
  type Envelope,
  type PlaybackSession,
  type Settings,
  type TranslationSegment,
} from './types';

export interface EngineDependencies {
  cache: Pick<SegmentCache, 'load' | 'put'>;
  files: Pick<LocalFiles, 'capture' | 'flush' | 'finish' | 'failed'>;
  background: <T = unknown>(type: string, parameters?: Record<string, unknown>) => Promise<T>;
  createWorker: () => Worker;
  closeWorker?: (worker: Worker) => Promise<void>;
  translate?: typeof translateWindow;
  now?: () => number;
  sleep?: typeof delay;
}
interface Epoch {
  generation: number;
  session: PlaybackSession;
  settings: Settings;
  signal: AbortSignal;
}
const totalCoverage = (ranges: Coverage[]) =>
  mergeCoverage(ranges).reduce((sum, range) => sum + range.end - range.start, 0);
const diagnosticsFor = (startedAt: number) => ({
  startedAt,
  firstReadyMs: 0,
  bufferCount: 0,
  inputSeconds: 0,
  preparedSeconds: 0,
  preparationWallSeconds: 0,
  outputSeconds: 0,
  usage: [] as unknown[],
  events: [] as Record<string, unknown>[],
  debugEvents: [] as Record<string, unknown>[],
  droppedCriticalEvents: 0,
  droppedDebugEvents: 0,
});

/** Runtime-independent engine: all browser IO is supplied by the offscreen entrypoint. */
export class PlaybackEngine {
  session: PlaybackSession | null = null;
  settings: Settings | null = null;
  diagnostics = diagnosticsFor(0);
  private abort?: AbortController;
  private worker?: Worker;
  private ranges: Coverage[] = [];
  private deliveredRanges: Coverage[] = [];
  private segments: TranslationSegment[] = [];
  private delivered = new Set<string>();
  private delivery?: { epoch: Epoch; promise: Promise<void>; dirty: boolean };
  private generation = 0;
  private languageEpoch = 0;
  private transitions: Promise<unknown> = Promise.resolve();
  private providers = new Set<Promise<unknown>>();
  private retiringWorkers = new Set<Promise<void>>();
  private authQueue: Promise<unknown> = Promise.resolve();
  private connections = new Set<string>();
  private knownRevisions = new Set<string>();
  private terminalKeys = new Set<string>();
  private lastPublish = -Infinity;
  private rebuffering = true;
  private userPaused = false;
  private decodeSerial = 0;
  private startPosition = 0;
  private lastVideoRate = 1;
  private stage?: { stats: ReturnType<typeof diagnosticsFor>; startedAt: number };
  constructor(private readonly dependencies: EngineDependencies) {}
  private get now() { return this.dependencies.now ?? Date.now; }
  private get sleep() { return this.dependencies.sleep ?? delay; }
  private get files() { return this.dependencies.files; }
  private get cache() { return this.dependencies.cache; }
  private bg<T = unknown>(type: string, parameters: Record<string, unknown> = {}) {
    return this.dependencies.background<T>(type, parameters);
  }
  private auth<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.authQueue.then(operation);
    this.authQueue = next.catch(() => {});
    return next;
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(operation);
    this.transitions = next.catch(() => {});
    return next;
  }
  private active(epoch: Epoch) {
    return !epoch.signal.aborted && this.generation === epoch.generation && this.session === epoch.session;
  }
  private cancel() {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      if (this.dependencies.closeWorker) {
        const closing = this.dependencies.closeWorker(worker).catch(() => {});
        this.retiringWorkers.add(closing);
        void closing.finally(() => this.retiringWorkers.delete(closing));
      } else worker.terminate();
    }
    this.delivery = undefined;
  }
  async settleDecoderCleanup() {
    await Promise.allSettled([...this.retiringWorkers]);
  }
  private checkpoint(context?: ArchiveContext) {
    // LocalFiles owns its IO queue. A slow export must never hold the next task open.
    void this.files.flush()
      .then(() => context ? this.files.finish(context) : undefined)
      .catch((error) => this.files.failed(error));
  }
  private resetPlayback() {
    this.ranges = [];
    this.deliveredRanges = [];
    this.segments = [];
    this.delivered.clear();
    this.lastPublish = -Infinity;
    this.rebuffering = true;
  }
  private cacheIdentity(session = this.session!) {
    const candidate = session.candidate;
    return `${candidate.mediaId}|audio:${candidate.source?.trackId ?? 'default'}`;
  }
  async stop(sessionId?: string): Promise<boolean> {
    if (sessionId && this.session?.id !== sessionId) return false;
    const context = this.session ? archiveContext(this.session) : undefined;
    this.cancel();
    const generation = this.generation;
    this.session = null;
    this.settings = null;
    this.resetPlayback();
    this.checkpoint(context);
    await this.queue(async () => {
      // Provider finalizers remove their own authentication before a new setup runs.
      await Promise.allSettled([...this.providers]);
      await this.authQueue;
      if (generation === this.generation && !this.session)
        await this.bg('auth:remove').catch(() => {});
    });
    return true;
  }
  async start(session: PlaybackSession, settings: Settings) {
    const previous = this.session ? archiveContext(this.session) : undefined;
    this.cancel();
    this.resetPlayback();
    this.diagnostics = diagnosticsFor(this.now());
    this.knownRevisions.clear();
    this.terminalKeys.clear();
    this.settings = { ...settings };
    this.userPaused = false;
    this.languageEpoch = session.epoch;
    this.checkpoint(previous);
    return this.initializeEpoch(session, session.position, true);
  }
  async switchLanguage(next: PlaybackSession, userPaused: boolean) {
    if (!this.session || this.session.id !== next.id ||
        (next.languageVersion ?? 0) <= (this.session.languageVersion ?? 0)) return;
    const previous = archiveContext(this.session);
    this.cancel();
    this.resetPlayback();
    this.userPaused = userPaused;
    this.languageEpoch = next.epoch;
    this.checkpoint(previous);
    return this.initializeEpoch(next, next.position, false);
  }
  async beginEpoch(position: number) {
    if (!this.session) return;
    const previous = this.session;
    this.cancel();
    this.resetPlayback();
    return this.initializeEpoch(previous, position, true);
  }
  private initializeEpoch(previous: PlaybackSession, position: number, advance: boolean) {
    const session: PlaybackSession = {
      ...previous,
      epoch: previous.epoch + Number(advance),
      candidate: { ...previous.candidate },
      position: Math.min(previous.candidate.duration, Math.max(0, position)),
      phase: 'buffering',
      readyThrough: position,
      inputThrough: position,
      error: undefined,
      segments: [],
    };
    this.session = session;
    this.knownRevisions.add(`${session.languageVersion ?? 0}:${session.epoch}`);
    this.startPosition = session.position;
    this.abort = new AbortController();
    const epoch: Epoch = { generation: this.generation, session, settings: this.settings!, signal: this.abort.signal };
    this.updatePreparation();
    return this.queue(async () => {
      if (!this.active(epoch)) return;
      await Promise.allSettled([...this.providers]);
      await this.authQueue;
      if (!this.active(epoch)) return;
      await this.bg('auth:remove').catch(() => {});
      if (!this.active(epoch)) return;
      const cached = await this.cache.load(this.cacheIdentity(session), session.language, VOICE);
      if (!this.active(epoch)) return;
      this.ranges = cached.ranges;
      this.segments = cached.segments;
      session.inputThrough = coverageEnd(this.ranges, session.position);
      // Publish the epoch in buffering state before delivering any audio for it.
      await this.publish(true);
      if (!this.active(epoch)) return;
      await this.deliverAvailable(epoch);
      if (!this.active(epoch)) return;
      // Cache hits can also be exported, without making disk IO part of readiness.
      void this.files.capture(archiveContext(session), session.position,
        coverageEnd(this.ranges, session.position), cached.segments, false)
        .catch((error) => this.files.failed(error));
      void this.produce(epoch).catch((error) => this.fail(epoch, error));
    }).catch(async (error) => {
      if (!this.active(epoch)) return;
      await this.fail(epoch, error);
      throw error;
    });
  }
  private currentEpoch(): Epoch | undefined {
    return this.session && this.settings && this.abort
      ? { generation: this.generation, session: this.session, settings: this.settings, signal: this.abort.signal }
      : undefined;
  }
  private async publish(force = false) {
    const session = this.session;
    if (!session) return;
    const now = this.now();
    if (!force && now - this.lastPublish < 250) return;
    this.lastPublish = now;
    this.updatePreparation();
    session.stateVersion = (session.stateVersion ?? 0) + 1;
    session.segments = this.segments.map(({ audio: _, audioDuration: __, mediaId: ___,
      language: ____, voice: _____, ...text }) => text);
    await this.bg('engine:state', { session: { ...session, segments: [...session.segments] } });
  }
  private updatePreparation() {
    if (!this.session) return;
    this.lastVideoRate = this.session.rate;
    const wall = this.diagnostics.preparationWallSeconds +
      (this.stage?.stats === this.diagnostics ? Math.max(0, this.now() - this.stage.startedAt) / 1000 : 0);
    this.session.preparation = preparationStatus(this.session.rate, this.diagnostics.inputSeconds,
      this.diagnostics.preparedSeconds, wall);
  }
  preparation() {
    this.updatePreparation();
    if (this.session?.preparation) return this.session.preparation;
    const wall = this.diagnostics.preparationWallSeconds +
      (this.stage?.stats === this.diagnostics ? Math.max(0, this.now() - this.stage.startedAt) / 1000 : 0);
    return preparationStatus(this.lastVideoRate, this.diagnostics.inputSeconds,
      this.diagnostics.preparedSeconds, wall);
  }
  private async fail(epoch: Epoch, error: unknown) {
    if (!this.active(epoch)) return;
    const context = archiveContext(epoch.session);
    epoch.session.phase = 'error';
    epoch.session.error = messageError(error);
    this.cancel();
    this.checkpoint(context);
    await this.publish(true);
  }
  private async sendSegment(epoch: Epoch, segment: TranslationSegment) {
    if (!this.active(epoch)) return false;
    const accepted = await this.bg<boolean>('engine:segment', {
      sessionId: epoch.session.id,
      epoch: epoch.session.epoch,
      languageVersion: epoch.session.languageVersion ?? 0,
      segment,
    });
    if (!this.active(epoch)) return false;
    if (accepted !== true) throw new Error('播放器未接收译音，请重新扫描视频后重试');
    this.delivered.add(segment.id);
    return true;
  }
  private deliverAvailable(epoch: Epoch): Promise<void> {
    if (!this.active(epoch)) return Promise.resolve();
    if (this.delivery?.epoch.generation === epoch.generation) {
      this.delivery.dirty = true;
      return this.delivery.promise;
    }
    const delivery = { epoch, dirty: true, promise: Promise.resolve() };
    this.delivery = delivery;
    delivery.promise = (async () => {
      while (delivery.dirty && this.active(epoch)) {
        delivery.dirty = false;
        const position = epoch.session.position;
        const end = Math.min(coverageEnd(this.ranges, position),
          position + bufferPolicy(epoch.session.rate).maxAheadSeconds,
          epoch.session.candidate.duration);
        const needed = this.segments.filter((segment) =>
          segment.end > position && segment.start < end && !this.delivered.has(segment.id));
        for (const segment of needed) {
          if (!await this.sendSegment(epoch, segment)) return;
        }
        if (!this.active(epoch)) return;
        // A progress callback may have added another utterance while an ACK was pending.
        if (this.segments.some((segment) => segment.end > position && segment.start < end &&
            !this.delivered.has(segment.id))) {
          delivery.dirty = true;
          continue;
        }
        if (end > position) this.deliveredRanges = mergeCoverage([
          ...this.deliveredRanges, { start: position, end },
        ]);
        const previousPhase = epoch.session.phase;
        this.updateReadiness();
        await this.publish(previousPhase !== epoch.session.phase);
      }
    })().finally(() => {
      if (this.delivery === delivery) this.delivery = undefined;
    });
    return delivery.promise;
  }
  private requestDelivery(epoch: Epoch) {
    void this.deliverAvailable(epoch).catch((error) => this.fail(epoch, error));
  }
  private updateReadiness() {
    const session = this.session;
    if (!session || session.phase === 'error' || session.phase === 'ended') return;
    session.readyThrough = coverageEnd(this.deliveredRanges, session.position);
    const ready = session.readyThrough - session.position;
    const tail = session.candidate.duration - session.position;
    const policy = bufferPolicy(session.rate);
    if (this.rebuffering && ready >= Math.min(policy.startupTargetSeconds, tail) - 0.08) {
      this.rebuffering = false;
      session.phase = this.userPaused ? 'paused' : 'playing';
      if (!this.diagnostics.firstReadyMs)
        this.diagnostics.firstReadyMs = Math.max(1, this.now() - this.diagnostics.startedAt);
    } else if (!this.rebuffering && ready < Math.max(0.25, policy.videoRate * 0.35) && tail > 0.15) {
      this.rebuffering = true;
      session.phase = 'buffering';
      this.diagnostics.bufferCount++;
    } else if (this.rebuffering) session.phase = 'buffering';
    this.updatePreparation();
  }
  private async decode(start: number, end: number, epoch: Epoch): Promise<Float32Array> {
    const source = await this.bg<AudioSource | undefined>('media:refresh', {
      sessionId: epoch.session.id,
      epoch: epoch.session.epoch,
      languageVersion: epoch.session.languageVersion ?? 0,
    });
    epoch.signal.throwIfAborted();
    if (!this.active(epoch)) throw abortError();
    if (source) epoch.session.candidate.source = source;
    if (!source) throw new Error('没有可预取的音轨');
    await this.bg('media:headers', { source, sessionId: epoch.session.id, epoch: epoch.session.epoch,
      languageVersion: epoch.session.languageVersion ?? 0 });
    epoch.signal.throwIfAborted();
    if (!this.active(epoch)) throw abortError();
    const worker = this.worker ??= this.dependencies.createWorker();
    const id = String(++this.decodeSerial);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', listener);
        epoch.signal.removeEventListener('abort', abort);
        clearTimeout(timer);
      };
      const abort = () => { cleanup(); reject(abortError()); };
      const listener = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        cleanup();
        if (!this.active(epoch)) return reject(abortError());
        if (event.data.ok) resolve(new Float32Array(event.data.samples));
        else {
          if (event.data.diagnostics) this.diagnostics.events.push({
            type: 'decode-error', at: this.now(), windows: event.data.diagnostics,
          });
          reject(new Error(event.data.error));
        }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('音轨读取超时，请刷新视频后重新扫描')); }, 60000);
      worker.addEventListener('message', listener);
      epoch.signal.addEventListener('abort', abort, { once: true });
      if (epoch.signal.aborted) return abort();
      worker.postMessage({ id, type: 'decode', source, start, end,
        expectedDuration: epoch.session.candidate.duration });
    });
  }
  private addCoverage(range: Coverage) {
    const before = totalCoverage(this.ranges);
    this.ranges = mergeCoverage([...this.ranges, range]);
    this.diagnostics.preparedSeconds += Math.max(0, totalCoverage(this.ranges) - before);
  }
  private async produce(epoch: Epoch) {
    let cursor = epoch.session.position;
    while (this.active(epoch)) {
      const session = epoch.session;
      if (cursor >= session.candidate.duration - 0.02) {
        this.checkpoint(archiveContext(session));
        return;
      }
      const existing = coverageEnd(this.ranges, cursor);
      if (existing > cursor + 0.02) { cursor = existing; continue; }
      while (this.active(epoch) && cursor - session.position >= bufferPolicy(session.rate).maintainTargetSeconds)
        await this.sleep(250, epoch.signal);
      if (!this.active(epoch)) return;
      const first = cursor === this.startPosition;
      const size = first ? bufferPolicy(session.rate).startupTargetSeconds : 60;
      const nextCachedStart = this.ranges.find((range) => range.start > cursor + 0.02)?.start ?? Infinity;
      const maximumEnd = Math.min(cursor + size, session.position + 90,
        session.candidate.duration, nextCachedStart);
      const stage = { stats: this.diagnostics, startedAt: this.now() };
      this.stage = stage;
      try {
        const decoded = await this.decode(cursor, maximumEnd, epoch);
        if (!this.active(epoch)) return;
        const cut = maximumEnd < session.candidate.duration ? silenceBoundary(decoded, size) : decoded.length;
        const samples = first ? decoded : decoded.slice(0, Math.max(16000, cut));
        const end = cursor + samples.length / 16000;
        if (end <= cursor) throw new Error('音轨解码没有取得有效音频');
        await this.translatePart(epoch, samples, cursor, end);
        if (!this.active(epoch)) return;
        cursor = end;
        this.segments = this.segments.filter((segment) => segment.end > session.position - 300);
      } finally {
        stage.stats.preparationWallSeconds += Math.max(0, this.now() - stage.startedAt) / 1000;
        if (this.stage === stage) this.stage = undefined;
        if (this.active(epoch)) this.updatePreparation();
      }
    }
  }
  private async translatePart(epoch: Epoch, samples: Float32Array, windowStart: number, windowEnd: number) {
    const session = epoch.session;
    const context = archiveContext(session);
    let lastInput = windowStart;
    let attemptStart = windowStart;
    for (let attempt = 0; ; attempt++) {
      if (!this.active(epoch)) return;
      const connection = crypto.randomUUID();
      let providerSession = connection;
      const task = (this.dependencies.translate ?? translateWindow)({
        url: endpoint(epoch.settings), mediaId: session.candidate.mediaId, language: session.language,
        start: attemptStart, samples: samples.subarray(Math.round((attemptStart - windowStart) * 16000)),
        signal: epoch.signal,
        beforeConnect: () => this.auth(async () => {
          epoch.signal.throwIfAborted();
          this.connections.add(connection);
          try {
            await this.bg('auth:install', { sessionId: session.id, epoch: session.epoch,
              languageVersion: session.languageVersion ?? 0 });
          } catch (error) { this.connections.delete(connection); throw error; }
        }),
        afterClose: () => this.auth(async () => {
          this.connections.delete(connection);
          if (!this.connections.size) await this.bg('auth:remove');
        }),
        onSegment: (segment) => {
          if (!this.active(epoch)) return;
          this.segments = this.segments.filter((old) => !sameArchiveUtterance(old, segment));
          this.segments.push(segment);
          this.segments.sort((a, b) => a.start - b.start);
          this.diagnostics.outputSeconds += segment.audioDuration;
          void this.files.capture(context, windowStart, windowEnd, [segment])
            .catch((error) => this.files.failed(error));
        },
        onEvent: (event) => {
          if (!this.active(epoch)) return;
          if (event.type === 'session.created') providerSession = event.session?.id ?? connection;
          if (event.type === 'session.updated' && event.session?.enable_voice_clone === true)
            this.recordDiagnostic({ type: 'provider:voice-confirmed', providerSession,
              frequency: event.session.voice_clone_options?.frequency });
          if (event.type === 'response.done' && event.response?.usage)
            this.diagnostics.usage.push({ ...event.response.usage, providerSession });
        },
        waitForHeadroom: async (position, sendingSignal) => {
          while (this.active(epoch) && position - session.position >= 90)
            await this.sleep(250, sendingSignal);
          sendingSignal.throwIfAborted();
          epoch.signal.throwIfAborted();
        },
        onProgress: (inputThrough, ready) => {
          if (!this.active(epoch)) return;
          session.inputThrough = Math.max(session.inputThrough, inputThrough);
          this.diagnostics.inputSeconds += Math.max(0, inputThrough - lastInput);
          lastInput = inputThrough;
          if (ready > attemptStart) this.addCoverage({ start: attemptStart, end: ready });
          this.requestDelivery(epoch);
        },
      });
      this.providers.add(task);
      try {
        await task;
        break;
      } catch (error) {
        if (!this.active(epoch) || attempt >= 2 || !/提前断开|连接失败|限流|超时/.test(messageError(error))) throw error;
        this.recordDiagnostic({ type: 'retry', at: this.now(), windowStart,
          attempt: attempt + 1, error: messageError(error) });
        attemptStart = coverageEnd(this.ranges, windowStart);
        lastInput = attemptStart;
        if (attemptStart >= windowEnd - 0.02) break;
        await this.sleep(1000 * 2 ** attempt, epoch.signal);
      } finally { this.providers.delete(task); }
    }
    if (!this.active(epoch)) return;
    this.addCoverage({ start: windowStart, end: windowEnd });
    const completed = this.segments.filter((segment) => segment.start >= windowStart - 0.03 && segment.end <= windowEnd + 0.03);
    await this.deliverAvailable(epoch);
    if (!this.active(epoch)) return;
    await this.cache.put(this.cacheIdentity(session), session.language, VOICE,
      { start: windowStart, end: windowEnd }, completed);
    if (!this.active(epoch)) return;
    void this.files.capture(context, windowStart, windowEnd, completed, true)
      .catch((error) => this.files.failed(error));
    await this.publish(true);
  }
  private recordDiagnostic(event: Record<string, unknown>) {
    const debug = event.type === 'player:metric' && event.kind === 'audio-stage';
    const events = debug ? this.diagnostics.debugEvents : this.diagnostics.events;
    events.push(event);
    if (events.length > (debug ? 1000 : 20000)) {
      events.shift();
      if (debug) this.diagnostics.droppedDebugEvents++;
      else this.diagnostics.droppedCriticalEvents++;
    }
  }
  recordTerminals(message: Envelope) {
    if (!this.session || message.sessionId !== this.session.id || !Array.isArray(message.events)) return false;
    for (const entry of message.events as Envelope[]) {
      if (entry?.sessionId !== this.session.id || entry.type !== 'player:metric' || entry.kind !== 'terminal' ||
          !this.knownRevisions.has(`${entry.languageVersion ?? 0}:${entry.epoch}`) ||
          typeof entry.segmentId !== 'string' || !Number.isFinite(entry.remaining) || Number(entry.remaining) < 0 ||
          !Number.isFinite(entry.sourceTime) || !Number.isFinite(entry.audioTime) ||
          !['natural', 'timeline-cut', 'overlap-cut', 'seek-stop', 'language-switch', 'stop', 'error', 'video-ended', 'player-lost'].includes(String(entry.reason))) continue;
      const key = `${entry.languageVersion ?? 0}:${entry.epoch}:${entry.segmentId}`;
      if (this.terminalKeys.has(key)) continue;
      this.terminalKeys.add(key);
      const { target: _, type, sessionId: __, ...event } = entry;
      this.recordDiagnostic({ ...event, type, at: this.now() });
    }
    return true;
  }
  async clock(message: Envelope) {
    const session = this.session;
    if (message.type === 'player:metric' && message.kind === 'terminal') {
      this.recordTerminals({ type: 'engine:terminals', sessionId: message.sessionId, events: [message] });
      return;
    }
    if (!session || message.sessionId !== session.id ||
        (message.languageVersion ?? 0) !== (session.languageVersion ?? 0)) return;
    if (message.type === 'player:seek') {
      if (Number(message.epoch) < this.languageEpoch || Number(message.epoch) > session.epoch) return;
      const position = Number(message.position);
      if (!Number.isFinite(position)) return;
      this.userPaused = Boolean(message.paused);
      await this.beginEpoch(position);
      return;
    }
    if (message.epoch !== session.epoch) return;
    if (message.type === 'player:skip' || message.type === 'player:metric') {
      const { target: _, type, sessionId: __, ...event } = message;
      this.recordDiagnostic({ ...event, type, epoch: session.epoch, at: this.now() });
      if (type === 'player:skip') {
        session.skipped++;
        const segment = this.segments.find((segment) => segment.id === message.segmentId);
        if (segment) segment.skipped = true;
        await this.publish(true);
      }
      return;
    }
    const position = Number(message.position);
    const rate = Number(message.rate);
    if (!Number.isFinite(position) || !Number.isFinite(rate) || rate <= 0) return;
    session.position = Math.min(session.candidate.duration, Math.max(0, position));
    session.rate = rate;
    if (message.userPaused !== undefined) this.userPaused = Boolean(message.userPaused);
    if (message.ended) {
      if (session.phase === 'ended') return;
      this.cancel();
      session.phase = 'ended';
      this.checkpoint(archiveContext(session));
      await this.publish(true);
      return;
    }
    if (!this.rebuffering && session.phase !== 'error') session.phase = this.userPaused ? 'paused' : 'playing';
    const epoch = this.currentEpoch();
    if (epoch && this.active(epoch)) await this.deliverAvailable(epoch).catch((error) => this.fail(epoch, error));
    this.updateReadiness();
    await this.publish();
  }
}
