/** Retire an old decoder without blocking cancellation or the next playback task. */
export async function closeDecodeWorker(
  worker: Worker,
  cleanup: () => Promise<unknown>,
  timeoutMs = 2000,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const id = crypto.randomUUID();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', finish);
      worker.terminate();
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'shutdown' && event.data.id === id) finish();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', finish);
    timer = setTimeout(finish, timeoutMs);
    try {
      worker.postMessage({ type: 'shutdown', id });
    } catch {
      finish();
    }
  });
  // Cleanup skips locked/live files, including those owned by the next decoder.
  await cleanup();
}
