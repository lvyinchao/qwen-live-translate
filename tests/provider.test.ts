import { afterEach, expect, it, vi } from 'vitest';
import { translateWindow } from '../lib/qwen';

const sent: Record<string, any>[] = [];
let confirmsClone = true;
let failureCode: string | undefined;
let disconnect = false;
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: ({ code }: { code: number }) => void;
  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
      this.receive({
        type: 'session.created',
        session: { model: 'qwen3.8-livetranslate-flash-realtime' },
      });
    });
  }
  receive(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(raw: string) {
    const event = JSON.parse(raw);
    sent.push(event);
    if (event.type === 'session.update' && failureCode) {
      queueMicrotask(() =>
        this.receive({ type: 'error', error: { code: failureCode } }),
      );
      return;
    }
    if (event.type === 'session.update' && disconnect) {
      queueMicrotask(() => this.onclose?.({ code: 1006 }));
      return;
    }
    if (event.type === 'session.update')
      queueMicrotask(() =>
        this.receive({
          type: 'session.updated',
          session: { enable_voice_clone: confirmsClone },
        }),
      );
    if (event.type === 'session.finish')
      setTimeout(() => this.receive({ type: 'session.finished' }), 50);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
function fixture() {
  sent.length = 0;
  confirmsClone = true;
  failureCode = undefined;
  disconnect = false;
  vi.stubGlobal('WebSocket', Socket);
  const cleanup = vi.fn(async () => {});
  return {
    cleanup,
    start: () =>
      translateWindow({
        url: 'wss://model.test',
        mediaId: 'test',
        language: 'zh',
        start: 0,
        samples: new Float32Array(1600),
        signal: new AbortController().signal,
        beforeConnect: async () => {},
        afterClose: cleanup,
        onSegment: () => {},
        onProgress: () => {},
      }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('requests source voice and waits for session.finished before cleanup', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finished = false;
  const promise = f.start().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  const session = sent.find((e) => e.type === 'session.update')!.session;
  expect(session.enable_voice_clone).toBe(true);
  expect(session.voice).toBe('default');
  expect(session.voice_clone_options.frequency).toBe('always');
  expect(sent.at(-1)?.type).toBe('session.finish');
  expect(finished).toBe(false);
  expect(f.cleanup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  await promise;
  expect(finished).toBe(true);
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('fails visibly and cleans authentication when cloning was not confirmed', async () => {
  const f = fixture();
  confirmsClone = false;
  await expect(f.start()).rejects.toThrow('未确认启用原音色');
  expect(f.cleanup).toHaveBeenCalledOnce();
  expect(sent.some((e) => e.type === 'input_audio_buffer.append')).toBe(false);
});

it('classifies rate limits and releases the temporary authentication rule', async () => {
  const f = fixture();
  failureCode = 'Throttling.RateLimit';
  await expect(f.start()).rejects.toThrow('限流');
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('rejects an interrupted connection without committing the window', async () => {
  const f = fixture();
  disconnect = true;
  await expect(f.start()).rejects.toThrow('提前断开');
  expect(f.cleanup).toHaveBeenCalledOnce();
});
