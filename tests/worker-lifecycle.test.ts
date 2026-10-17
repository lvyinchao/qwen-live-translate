import { afterEach, expect, it, vi } from 'vitest';
import { closeDecodeWorker } from '../lib/worker-lifecycle';

class WorkerFixture extends EventTarget {
  lastMessage?: { type: string; id: string };
  terminate = vi.fn();
  postMessage(message: { type: string; id: string }) {
    this.lastMessage = message;
  }
  reply(id = this.lastMessage!.id) {
    this.dispatchEvent(new MessageEvent('message', { data: { type: 'shutdown', id, ok: true } }));
  }
}
afterEach(() => {
  vi.useRealTimers();
});
it('waits for the matching shutdown acknowledgement before terminating and cleanup', async () => {
  const worker = new WorkerFixture();
  const cleanup = vi.fn(async () => {});
  const close = closeDecodeWorker(worker as unknown as Worker, cleanup);
  worker.reply('unrelated-message');
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
  worker.reply();
  await close;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});
it('terminates a decoder that fails to acknowledge and still attempts abandoned-file cleanup', async () => {
  vi.useFakeTimers();
  const worker = new WorkerFixture();
  const cleanup = vi.fn(async () => {});
  const close = closeDecodeWorker(worker as unknown as Worker, cleanup, 2000);
  await vi.advanceTimersByTimeAsync(1999);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await close;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});
