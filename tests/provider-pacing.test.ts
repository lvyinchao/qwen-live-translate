import { afterEach, expect, it, vi } from 'vitest';
import { delay, translateWindow, type TranslateWindowOptions } from '../lib/qwen';

let socket: RealtimeFixture;
const frames: { at: number; type: string }[] = [];
class RealtimeFixture {
  readyState = 1;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- exposes the fixture socket to the test
    socket = this;
    queueMicrotask(() => {
      this.onopen?.();
      this.receive({ type: 'session.created', session: { model: 'qwen3.8-livetranslate-flash-realtime' } });
    });
  }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  send(raw: string) {
    const event = JSON.parse(raw);
    frames.push({ at: Date.now(), type: event.type });
    if (event.type === 'session.update') queueMicrotask(() => this.receive({ type: 'session.updated', session: { enable_voice_clone: true } }));
    if (event.type === 'session.finish') queueMicrotask(() => this.receive({ type: 'session.finished' }));
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
function run(waitForHeadroom?: TranslateWindowOptions['waitForHeadroom']) {
  frames.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('WebSocket', RealtimeFixture);
  const abort = new AbortController();
  const afterClose = vi.fn(async () => {});
  const result = translateWindow({
    url: 'wss://isolated-fixture.test', mediaId: 'fixture', language: 'zh', start: 0,
    samples: new Float32Array(16000), signal: abort.signal,
    beforeConnect: async () => {}, afterClose, onSegment: () => {}, onProgress: () => {}, waitForHeadroom,
  });
  return { result, abort, afterClose };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('continues to send at most one 100 ms input frame per 100 ms instead of assuming faster model ingestion', async () => {
  const f = run();
  await vi.advanceTimersByTimeAsync(99);
  expect(frames.filter((event) => event.type === 'input_audio_buffer.append')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(901);
  await f.result;
  const input = frames.filter((event) => event.type === 'input_audio_buffer.append');
  expect(input).toHaveLength(10);
  expect(input.map((frame) => frame.at)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  expect(frames.at(-1)).toMatchObject({ type: 'session.finish', at: 1000 });
  expect(f.afterClose).toHaveBeenCalledOnce();
});
it('honors transport backpressure and cancellation without sending queued audio after abort', async () => {
  const f = run();
  await vi.advanceTimersByTimeAsync(0);
  socket.bufferedAmount = 300 * 1024;
  const observed = f.result.catch((error) => error);
  await vi.advanceTimersByTimeAsync(500);
  const before = frames.filter((event) => event.type === 'input_audio_buffer.append').length;
  expect(before).toBe(1);
  f.abort.abort();
  const error = await observed;
  expect(error.name).toBe('AbortError');
  await vi.advanceTimersByTimeAsync(500);
  expect(frames.filter((event) => event.type === 'input_audio_buffer.append')).toHaveLength(before);
  expect(frames.some((event) => event.type === 'session.finish')).toBe(false);
  expect(f.afterClose).toHaveBeenCalledOnce();
});

it('stops a backpressured sender immediately when the provider fails, even without an external abort', async () => {
  const f = run();
  const observed = f.result.catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  socket.bufferedAmount = 300 * 1024;
  await vi.advanceTimersByTimeAsync(100);
  socket.receive({ type: 'error', error: { code: 'Throttling.RateLimit' } });
  expect((await observed).message).toContain('限流');
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.afterClose).toHaveBeenCalledOnce();
});
it('cancels a headroom wait when the socket settles so no orphan wait loop remains', async () => {
  let sendingSignal!: AbortSignal;
  const f = run(async (_position, signal) => {
    sendingSignal = signal;
    await delay(60000, signal);
  });
  const observed = f.result.catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(sendingSignal.aborted).toBe(false);
  socket.receive({ type: 'error', error: { code: 'ProviderFailure' } });
  expect((await observed).message).toContain('ProviderFailure');
  await vi.advanceTimersByTimeAsync(0);
  expect(sendingSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(frames.some((event) => event.type === 'input_audio_buffer.append')).toBe(false);
});
