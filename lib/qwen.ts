import { decode64, encode64, pcm16, wav } from './audio';
import {
  MODEL,
  OUTPUT_RATE,
  VOICE,
  MODEL_VOICE,
  type TranslationSegment,
} from './types';

interface SourceTurn {
  start?: number;
  end?: number;
  text: string;
  speaker?: number;
  transcriptionDone?: boolean;
}
interface OutputTurn {
  source?: string;
  text: string;
  parts: Uint8Array[];
  done: boolean;
  emitted: boolean;
}
export type ProviderEvent = Record<string, any>;
export class TranslationAssembler {
  sources = new Map<string, SourceTurn>();
  outputs = new Map<string, OutputTurn>();
  segments: TranslationSegment[] = [];
  constructor(
    private context: {
      start: number;
      end: number;
      mediaId: string;
      language: string;
    },
    private onSegment: (segment: TranslationSegment) => void = () => {},
  ) {}
  source(id: string) {
    if (!this.sources.has(id)) this.sources.set(id, { text: '' });
    return this.sources.get(id)!;
  }
  output(id: string) {
    if (!this.outputs.has(id))
      this.outputs.set(id, {
        text: '',
        parts: [],
        done: false,
        emitted: false,
      });
    return this.outputs.get(id)!;
  }
  consume(event: ProviderEvent) {
    const id = event.item_id as string | undefined;
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        if (id)
          Object.assign(this.source(id), {
            start: this.context.start + event.audio_start_ms / 1000,
            speaker: event.speaker_id,
          });
        break;
      case 'input_audio_buffer.speech_stopped':
        if (id)
          this.source(id).end = Math.min(
            this.context.end,
            this.context.start + event.audio_end_ms / 1000,
          );
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (id) this.source(id).text += event.delta ?? '';
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (id)
          Object.assign(this.source(id), {
            text: event.transcript ?? this.source(id).text,
            transcriptionDone: true,
          });
        break;
      case 'conversation.item.created':
        if (event.item?.role === 'assistant' && event.item.id)
          this.output(event.item.id).source = event.previous_item_id;
        break;
      case 'response.audio_transcript.delta':
        if (id) this.output(id).text += event.delta ?? '';
        break;
      case 'response.audio_transcript.done':
        if (id && event.transcript) this.output(id).text = event.transcript;
        break;
      case 'response.audio.delta':
        if (id && event.delta)
          this.output(id).parts.push(decode64(event.delta));
        break;
      case 'response.done':
        if (event.response?.status && event.response.status !== 'completed')
          throw new Error('翻译响应未完整完成，请重试当前片段');
        for (const item of event.response?.output ?? [])
          if (item.id) this.output(item.id).done = true;
        break;
      case 'response.audio.done':
        // Audio is complete; response.done still gates commitment.
        break;
    }
    this.commitReady();
  }
  commitReady() {
    for (const [id, output] of this.outputs) {
      if (
        !output.done ||
        output.emitted ||
        !output.parts.length ||
        !output.source
      )
        continue;
      const source = this.sources.get(output.source);
      if (
        source?.start === undefined ||
        source.end === undefined ||
        source.end <= source.start
      )
        continue;
      const size = output.parts.reduce((sum, p) => sum + p.length, 0);
      const segment: TranslationSegment = {
        id,
        mediaId: this.context.mediaId,
        language: this.context.language,
        voice: VOICE,
        start: source.start,
        end: source.end,
        speaker: source.speaker,
        sourceText: source.text,
        text: output.text,
        audio: encode64(wav(output.parts)),
        audioDuration: size / (OUTPUT_RATE * 2),
      };
      output.emitted = true;
      this.segments.push(segment);
      this.onSegment(segment);
    }
  }
  coverage(): number {
    let through = this.context.start;
    for (const [id, source] of [...this.sources].sort(
      (a, b) => (a[1].start ?? Infinity) - (b[1].start ?? Infinity),
    )) {
      const outputs = [...this.outputs.values()].filter((o) => o.source === id);
      // VAD also fires for breath/noise. Only a FINAL empty ASR result permits
      // a silent interval; meaningful text still requires a complete audio response.
      if (
        source.end !== undefined &&
        source.transcriptionDone &&
        !source.text.trim() &&
        outputs.every((o) => !o.parts.length)
      ) {
        through = Math.max(through, source.end);
        continue;
      }
      if (
        source.end === undefined ||
        !outputs.length ||
        outputs.some((o) => !o.emitted)
      )
        break;
      through = Math.max(through, source.end);
    }
    return through;
  }
  finish() {
    this.commitReady();
    if ([...this.outputs.values()].some((o) => o.parts.length && !o.emitted))
      throw new Error(
        '模型译音缺少可靠的源时间戳或消息关联，已停止本段以防音画错位',
      );
    for (const [id, source] of this.sources) {
      if (
        source.start !== undefined &&
        !(source.transcriptionDone && !source.text.trim()) &&
        ![...this.outputs.values()].some((o) => o.source === id && o.emitted)
      )
        throw new Error('检测到人声但没有获得完整译音，请重试');
    }
    return this.segments;
  }
}

export interface TranslateWindowOptions {
  url: string;
  mediaId: string;
  language: string;
  start: number;
  samples: Float32Array;
  signal: AbortSignal;
  beforeConnect: () => Promise<void>;
  afterClose: () => Promise<void>;
  onSegment: (segment: TranslationSegment) => void;
  onProgress: (inputThrough: number, readyThrough: number) => void;
  waitForHeadroom?: (position: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: ProviderEvent) => void;
}
export const abortError = () => new DOMException('任务已取消', 'AbortError');
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const finish = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export async function translateWindow(
  options: TranslateWindowOptions,
): Promise<TranslationSegment[]> {
  await options.beforeConnect();
  if (options.signal.aborted) {
    await options.afterClose();
    throw abortError();
  }
  const end = options.start + options.samples.length / 16000;
  const assembler = new TranslationAssembler(
    { ...options, end },
    options.onSegment,
  );
  let socket: WebSocket | undefined;
  try {
    return await new Promise<TranslationSegment[]>((resolve, reject) => {
      const ws = (socket = new WebSocket(options.url));
      let settled = false,
        configured = false,
        sending = false;
      let inputThrough = options.start;
      let timer: ReturnType<typeof setTimeout>;
      const senderAbort = new AbortController();
      const done = (error?: unknown) => {
        if (settled) return;
        settled = true;
        senderAbort.abort();
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        ws.close();
        if (error) reject(error);
        else {
          try {
            resolve(assembler.finish());
          } catch (e) {
            reject(e);
          }
        }
      };
      const armTimeout = (ms = 45000) => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            done(new Error('模型连接或响应超时，请检查地域、网络和模型权限')),
          ms,
        );
      };
      const abort = () => done(abortError());
      options.signal.addEventListener('abort', abort, { once: true });
      const send = (value: unknown) => ws.send(JSON.stringify(value));
      armTimeout(20000);
      ws.onopen = () => {
        armTimeout();
      };
      ws.onerror = () =>
        done(
          new Error(
            '百炼 WebSocket 连接失败：请检查 Key、Workspace、地域和模型访问权限',
          ),
        );
      ws.onclose = (event) => {
        if (!settled)
          done(
            new Error(`翻译连接提前断开（${event.code}），本段未标记为完成`),
          );
      };
      ws.onmessage = (event) => {
        if (settled) return;
        armTimeout(sending ? 150000 : 45000);
        try {
          const data = JSON.parse(event.data) as ProviderEvent;
          options.onEvent?.(data);
          if (data.type === 'error') {
            const code = String(data.error?.code ?? 'unknown');
            return done(
              new Error(
                /limit|throttl|429/i.test(code)
                  ? `百炼限流：${code}`
                  : `百炼返回错误：${code}，请核对模型权限和配置`,
              ),
            );
          }
          if (data.type === 'session.created') {
            if (data.session?.model && data.session.model !== MODEL)
              return done(new Error('连接返回了不同模型，已停止'));
            send({
              type: 'session.update',
              session: {
                output_modalities: ['text', 'audio'],
                translation: { language: options.language },
                enable_voice_clone: true,
                voice: MODEL_VOICE,
                voice_clone_options: { frequency: 'always' },
                audio: {
                  input: {
                    format: { type: 'pcm', sample_rate: 16000 },
                    turn_detection: {
                      type: 'server_vad',
                      threshold: 0.5,
                      silence_duration_ms: 200,
                      interrupt_response: false,
                      create_response: true,
                    },
                  },
                  output: {
                    format: { type: 'pcm', sample_rate: 24000 },
                    voice: MODEL_VOICE,
                  },
                },
              },
            });
          } else if (data.type === 'session.updated' && !configured) {
            if (data.session?.enable_voice_clone !== true)
              return done(new Error('模型未确认启用原音色复刻，已停止翻译'));
            configured = true;
            sending = true;
            void (async () => {
              for (let i = 0; i < options.samples.length; i += 1600) {
                if (settled || options.signal.aborted) return;
                await options.waitForHeadroom?.(options.start + i / 16000, senderAbort.signal);
                if (settled || options.signal.aborted) return;
                while (!settled && ws.bufferedAmount > 256 * 1024)
                  await delay(100, senderAbort.signal);
                if (settled || options.signal.aborted) return;
                send({
                  type: 'input_audio_buffer.append',
                  audio: encode64(pcm16(options.samples.subarray(i, i + 1600))),
                });
                armTimeout(45000);
                inputThrough =
                  options.start +
                  Math.min(i + 1600, options.samples.length) / 16000;
                options.onProgress(inputThrough, assembler.coverage());
                // Do not assume the provider accepts faster-than-real-time input.
                await delay(100, senderAbort.signal);
              }
              sending = false;
              if (!settled) {
                send({ type: 'session.finish' });
                armTimeout(45000);
              }
            })().catch(done);
          } else if (data.type === 'session.finished') {
            done();
          } else {
            assembler.consume(data);
            options.onProgress(inputThrough, assembler.coverage());
          }
        } catch (error) {
          done(error);
        }
      };
    });
  } finally {
    if (socket && socket.readyState < 2) socket.close();
    await options.afterClose();
  }
}
