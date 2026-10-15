import CaptureWorker from '../workers/capture?worker';
import { translateWindow } from './qwen';
import { endpoint } from './security';
import {
  messageError,
  VOICE,
  type Settings,
  type TranslationSegment,
} from './types';
import {
  captureShouldPause,
  CaptureClock,
  COMPAT_DISK_LIMIT,
  type CompatState,
} from './compat';
import type { LocalFiles } from './local-files';
import type { ArchiveContext } from './archive';

type Call = <T = unknown>(
  type: string,
  data?: Record<string, unknown>,
) => Promise<T>;
export class CaptureEngine {
  state: CompatState | null = null;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private worker?: Worker;
  private channel?: BroadcastChannel;
  private folder?: FileSystemDirectoryHandle;
  private abort?: AbortController;
  private writes = Promise.resolve();
  private translation = Promise.resolve();
  private segments: TranslationSegment[] = [];
  private tick?: ReturnType<typeof setInterval>;
  private changing = false;
  private captureClock = new CaptureClock();
  private pendingBytes = 0;
  private captureEnded = false;
  private stopping = false;
  private context?: ArchiveContext;
  constructor(
    private call: Call,
    private files: LocalFiles,
  ) {}
  async start(state: CompatState, streamId: string, settings: Settings) {
    await this.stop();
    this.state = state;
    this.stopping = false;
    this.captureEnded = false;
    this.changing = false;
    this.pendingBytes = 0;
    this.segments = [];
    this.writes = Promise.resolve();
    this.translation = Promise.resolve();
    const abort = (this.abort = new AbortController());
    this.context = {
      mediaId: state.candidate.mediaId,
      title: state.candidate.title,
      language: state.language,
      voice: VOICE,
      trackId: `tab-capture:${state.id}:source-offset=${state.candidate.currentTime}`,
    };
    const root = await navigator.storage.getDirectory();
    // Only temporary captures use this prefix; permanent translated files have
    // their own directory. Reclaim captures left by an extension/browser crash.
    for await (const [name] of (
      root as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (name.startsWith('capture-'))
        await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
    this.folder = await root.getDirectoryHandle(`capture-${state.id}`, {
      create: true,
    });
    this.channel = new BroadcastChannel(`qvd-capture-${state.id}`);
    this.channel.onmessage = (e) => {
      if (abort.signal.aborted) return;
      if (e.data.type === 'hello') {
        this.publish();
        this.segments.forEach((segment) =>
          this.channel?.postMessage({ type: 'segment', segment }),
        );
      }
      if (e.data.type === 'clock' && Number.isFinite(e.data.position)) {
        state.position = Math.max(
          0,
          Math.min(state.capturedThrough, e.data.position),
        );
      }
      if (
        e.data.type === 'get' &&
        Number.isInteger(e.data.seq) &&
        e.data.seq >= 0 &&
        e.data.seq < state.chunks
      ) {
        const seq = e.data.seq;
        void this.folder
          ?.getFileHandle(String(seq))
          .then((h) => h.getFile())
          .then((blob) => {
            if (!abort.signal.aborted)
              this.channel?.postMessage({ type: 'chunk', seq, blob });
          })
          .catch((error) => this.fail(error));
      }
    };
    try {
      const constraint = {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      };
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: constraint,
        video: {
          mandatory: {
            ...constraint.mandatory,
            maxWidth: 1280,
            maxHeight: 720,
            maxFrameRate: 30,
          },
        },
      } as unknown as MediaStreamConstraints);
      if (
        !this.stream.getAudioTracks().length ||
        !this.stream.getVideoTracks().length
      )
        throw new Error('Tab capture did not provide both audio and video.');
      this.worker = new CaptureWorker();
      this.worker.onmessage = (e) => {
        if (abort.signal.aborted) return;
        const m = e.data;
        if (m.type === 'error') {
          void this.fail(new Error(m.error));
          return;
        }
        if (m.type === 'progress') {
          state.capturedThrough = m.through;
        }
        if (m.type === 'window') {
          this.translation = this.translation
            .then(async () => {
              if (abort.signal.aborted) return;
              const segments: TranslationSegment[] = [];
              const samples = m.samples as Float32Array;
              state.inputRms = Math.sqrt(
                samples.reduce((n, x) => n + x * x, 0) /
                  Math.max(1, samples.length),
              );
              await translateWindow({
                url: endpoint(settings),
                mediaId: state.candidate.mediaId,
                language: state.language,
                start: m.start,
                samples: m.samples,
                signal: abort.signal,
                beforeConnect: async () => {
                  await this.call('auth:install', { compatId: state.id });
                },
                afterClose: async () => {
                  await this.call('auth:remove', { compatId: state.id });
                },
                onSegment: (segment) => {
                  if (abort.signal.aborted) return;
                  segments.push(segment);
                  this.segments.push(segment);
                  state.utterances = (state.utterances ?? 0) + 1;
                  this.channel?.postMessage({ type: 'segment', segment });
                  void this.files
                    .capture(this.context!, m.start, m.end, [segment])
                    .catch((error) => {
                      if (!abort.signal.aborted) return this.fail(error);
                    });
                },
                onProgress: (_input, ready) => {
                  if (!abort.signal.aborted)
                    state.readyThrough = Math.max(state.readyThrough, ready);
                },
              });
              if (abort.signal.aborted) return;
              await this.files.capture(
                this.context!,
                m.start,
                m.end,
                segments,
                true,
              );
              state.readyThrough = m.end;
              this.publish();
            })
            .catch((error) => {
              if (!abort.signal.aborted) void this.fail(error);
            });
        }
        if (m.type === 'ended') {
          void this.translation.then(async () => {
            if (abort.signal.aborted) return;
            state.phase = 'ended';
            this.publish();
            await this.files
              .finish(this.context)
              .catch((error) => this.files.failed(error));
          });
        }
      };
      this.worker.onerror = (e) => {
        if (!abort.signal.aborted)
          void this.fail(new Error(e.message || 'Capture decoder failed.'));
      };
      this.worker.postMessage({ type: 'start' });
      const mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType))
        throw new Error('This Chrome cannot record VP8/Opus WebM.');
      const recorder = (this.recorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: 2_000_000,
        audioBitsPerSecond: 128_000,
      }));
      recorder.ondataavailable = (e) => {
        if (!e.data.size || abort.signal.aborted) return;
        this.pendingBytes += e.data.size;
        if (this.pendingBytes > 16 * 1024 * 1024) {
          void this.fail(
            new Error(
              'Local capture storage cannot keep up. Free disk space and retry.',
            ),
          );
          return;
        }
        this.writes = this.writes
          .then(async () => {
            if (abort.signal.aborted) return;
            if (state.bytes + e.data.size > COMPAT_DISK_LIMIT)
              throw new Error(
                'Temporary capture reached 2 GiB. Stop and start a new compatibility session.',
              );
            const h = await this.folder!.getFileHandle(String(state.chunks), {
              create: true,
            });
            const writer = await h.createWritable();
            await writer.write(e.data);
            await writer.close();
            const bytes = await e.data.arrayBuffer();
            this.worker?.postMessage({ type: 'chunk', bytes }, [bytes]);
            state.chunks++;
            state.bytes += e.data.size;
            this.publish();
          })
          .catch((error) => this.fail(error))
          .finally(() => {
            this.pendingBytes -= e.data.size;
          });
      };
      recorder.onerror = () => {
        if (!abort.signal.aborted)
          void this.fail(new Error('Chrome stopped recording the tab.'));
      };
      recorder.onstop = () => {
        const worker = this.worker;
        void this.writes.then(() => {
          if (!abort.signal.aborted && this.state?.id === state.id)
            worker?.postMessage({ type: 'end' });
        });
      };
      this.stream.getTracks().forEach(
        (track) =>
          (track.onended = () => {
            if (!abort.signal.aborted)
              void this.fail(
                new Error('Tab capture ended. Source settings restored.'),
              );
          }),
      );
      this.captureClock.start(performance.now());
      recorder.start(1000);
      await this.call('compat:source', { id: state.id, action: 'play' });
      state.phase = 'recording';
      this.tick = setInterval(() => {
        void this.regulate();
        this.publish();
      }, 500);
      this.publish();
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }
  private publish() {
    if (!this.state) return;
    this.segments = this.segments.filter(
      (s) => s.end >= this.state!.position - 120,
    );
    this.channel?.postMessage({ type: 'state', state: this.state });
    void this.call('compat:state', { state: this.state }).catch(() => {});
  }
  private async regulate() {
    const s = this.state,
      r = this.recorder;
    if (
      !s ||
      !r ||
      this.changing ||
      this.captureEnded ||
      s.phase === 'error' ||
      this.stopping
    )
      return;
    const pause = captureShouldPause(
      Math.max(s.capturedThrough, this.captureClock.seconds(performance.now())),
      s.readyThrough,
      s.position,
      s.sourcePaused,
    );
    if (pause === s.sourcePaused) return;
    this.changing = true;
    try {
      if (pause) {
        await this.call('compat:source', { id: s.id, action: 'pause' });
        if (r.state === 'recording') {
          r.pause();
          this.captureClock.pause(performance.now());
        }
      } else {
        if (r.state === 'paused') {
          r.resume();
          this.captureClock.resume(performance.now());
        }
        await this.call('compat:source', { id: s.id, action: 'play' });
      }
      s.sourcePaused = pause;
    } catch (error) {
      await this.fail(error);
    } finally {
      this.changing = false;
    }
  }
  end() {
    if (this.captureEnded) return;
    this.captureEnded = true;
    if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
  async fail(error: unknown) {
    if (!this.state || this.stopping) return;
    const state = this.state,
      context = this.context;
    state.phase = 'error';
    state.error = messageError(error);
    this.publish();
    this.abort?.abort();
    await this.call('compat:source', {
      id: this.state.id,
      action: 'pause',
    }).catch(() => {});
    if (this.state !== state || this.stopping) return;
    this.end();
    this.worker?.terminate();
    clearInterval(this.tick);
    await this.call('compat:restore', { id: state.id }).catch(() => {});
    await this.files.finish(context).catch((e) => this.files.failed(e));
  }
  async stop() {
    if (!this.state) return;
    this.stopping = true;
    const id = this.state.id;
    this.abort?.abort();
    await this.call('compat:source', { id, action: 'pause' }).catch(() => {});
    this.end();
    clearInterval(this.tick);
    this.worker?.terminate();
    // Wait for the old socket cleanup before allowing a new auth rule.
    await this.translation.catch(() => {});
    await this.writes.catch(() => {});
    await this.call('compat:restore', { id }).catch(() => {});
    this.state.phase = 'stopped';
    this.publish();
    this.channel?.close();
    await this.files.finish(this.context).catch((e) => this.files.failed(e));
    await navigator.storage
      .getDirectory()
      .then((root) => root.removeEntry(`capture-${id}`, { recursive: true }))
      .catch(() => {});
    this.state = null;
    this.recorder = undefined;
    this.stream = undefined;
    this.worker = undefined;
  }
}
