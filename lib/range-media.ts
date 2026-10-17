/** Bounded RAM, seekable disk backing for CDNs that ignore HTTP Range. */
export const MEDIA_DISK_LIMIT = 2 * 1024 ** 3;
const CHUNK = 64 * 1024;
export const MEDIA_RANGE_ERRORS = {
  timeout: '音轨服务器读取超时，请重试',
  truncated: '音轨服务器返回的数据不完整，请刷新资源后重试',
  quota: '音轨临时存储空间不足，请释放磁盘空间后重试',
  limit: '不支持范围读取的音轨超过 2 GiB，无法提前读取',
  storage: '当前浏览器无法创建音轨临时文件，请检查本地存储权限',
};
export interface MediaDisk {
  write(data: Uint8Array, position: number): number;
  read(data: Uint8Array, position: number): number;
  remove(): Promise<void>;
}
// Sync access handles are worker-only, so keep their small interface out of DOM types.
interface SyncFile {
  write(data: Uint8Array, options: { at: number }): number;
  read(data: Uint8Array, options: { at: number }): number;
  close(): void;
}
type MediaDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};
export interface MediaTempSummary {
  bytes: number;
  files: number;
}
export interface MediaTempCleanup extends MediaTempSummary {
  removedBytes: number;
  removedFiles: number;
}
// Serialize creation and cleanup across extension contexts. A live worker's sync
// handle additionally prevents deletion of the original media it is reading.
async function mediaDirectoryLock<T>(operation: () => Promise<T>): Promise<T> {
  return navigator.locks
    ? navigator.locks.request('timbradub-media-temp-directory', operation)
    : operation();
}
async function mediaDirectory(create = false) {
  return (await (await navigator.storage.getDirectory()).getDirectoryHandle(
    'qwen-video-dub-media-tmp', { create },
  )) as MediaDirectory;
}
async function inspectMediaTemps(remove: boolean): Promise<MediaTempCleanup> {
  let directory: MediaDirectory;
  const summary = { bytes: 0, files: 0, removedBytes: 0, removedFiles: 0 };
  try {
    directory = await mediaDirectory();
  } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') return summary;
    throw error;
  }
  for await (const [name, entry] of directory.entries()) {
    if (entry.kind !== 'file') continue;
    const file = await (entry as FileSystemFileHandle).getFile();
    if (remove) {
      try {
        await directory.removeEntry(name);
        summary.removedBytes += file.size;
        summary.removedFiles++;
        continue;
      } catch (error) {
        // Locked by a live decoder: preserve it. Other errors should be visible
        // to an explicit cleanup request instead of claiming that bytes vanished.
        if (!['NoModificationAllowedError', 'InvalidStateError'].includes((error as DOMException).name))
          throw error;
      }
    }
    summary.bytes += file.size;
    summary.files++;
  }
  return summary;
}
export async function mediaTempSummary(): Promise<MediaTempSummary> {
  const { bytes, files } = await mediaDirectoryLock(() => inspectMediaTemps(false));
  return { bytes, files };
}
/** Safe after worker termination and while another worker is decoding. */
export async function cleanupMediaTemps(): Promise<MediaTempCleanup> {
  return mediaDirectoryLock(() => inspectMediaTemps(true));
}
export async function privateMediaDisk(): Promise<MediaDisk> {
  try {
    return await mediaDirectoryLock(async () => {
      const directory = await mediaDirectory(true);
      await inspectMediaTemps(true);
      const name = crypto.randomUUID();
      const file = (await directory.getFileHandle(name, {
        create: true,
      })) as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncFile>;
      };
      let handle: SyncFile;
      try {
        handle = await file.createSyncAccessHandle();
      } catch (error) {
        await directory.removeEntry(name).catch(() => { });
        throw error;
      }
      let removed = false;
      return {
        write: (data, position) => handle.write(data, { at: position }),
        read: (data, position) => handle.read(data, { at: position }),
        async remove() {
          if (removed) return;
          removed = true;
          await mediaDirectoryLock(async () => {
            handle.close();
            await directory.removeEntry(name).catch((error) => {
              if ((error as DOMException).name !== 'NotFoundError') throw error;
            });
          });
        },
      };
    });
  } catch {
    throw new Error(MEDIA_RANGE_ERRORS.storage);
  }
}
class SequentialFile {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private position = 0;
  private ended = false;
  private closed = false;
  private failure: unknown;
  private queue = Promise.resolve();
  private length: number | undefined;
  constructor(
    response: Response,
    private disk: MediaDisk,
    private controller: AbortController,
    private idleMs: number,
    private onFailure: () => void,
  ) {
    this.reader = response.body!.getReader();
    const length = response.headers.get('Content-Length');
    if (length && !response.headers.get('Content-Encoding')) {
      const parsed = Number(length);
      if (Number.isSafeInteger(parsed) && parsed >= 0) this.length = parsed;
    }
  }
  private async ensure(end: number) {
    const operation = this.queue.then(async () => {
      if (this.closed) throw new DOMException('Cancelled', 'AbortError');
      if (this.failure) throw this.failure;
      if (this.length !== undefined && this.length > MEDIA_DISK_LIMIT)
        throw new Error(MEDIA_RANGE_ERRORS.limit);
      while (this.position < end && !this.ended) {
        const timer = setTimeout(() => this.controller.abort(), this.idleMs);
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await this.reader.read();
        } catch (error) {
          if (this.controller.signal.aborted && !this.closed)
            throw new Error(MEDIA_RANGE_ERRORS.timeout, { cause: error });
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (this.closed) throw new DOMException('Cancelled', 'AbortError');
        if (next.done) {
          this.ended = true;
          if (this.length !== undefined && this.position !== this.length)
            throw new Error(MEDIA_RANGE_ERRORS.truncated);
          this.length = this.position;
          break;
        }
        if (this.position + next.value.length > MEDIA_DISK_LIMIT)
          throw new Error(MEDIA_RANGE_ERRORS.limit);
        // Retain no accumulated byte arrays in JS; old bytes stay seekable on disk.
        try {
          if (this.disk.write(next.value, this.position) !== next.value.length)
            throw new Error('Short write');
        } catch {
          throw new Error(MEDIA_RANGE_ERRORS.quota);
        }
        this.position += next.value.length;
        if (this.length !== undefined && this.position > this.length)
          throw new Error(MEDIA_RANGE_ERRORS.truncated);
      }
      if (this.position < end && end !== Infinity)
        throw new Error(MEDIA_RANGE_ERRORS.truncated);
    });
    this.queue = operation.catch((error) => {
      this.failure = error;
      this.controller.abort();
      this.onFailure();
    });
    return operation;
  }
  async response(
    start: number,
    requestedEnd: number | undefined,
    signal?: AbortSignal | null,
  ) {
    signal?.throwIfAborted();
    if (this.length === undefined) await this.ensure(Infinity);
    const length = this.length!;
    if (length > MEDIA_DISK_LIMIT) throw new Error(MEDIA_RANGE_ERRORS.limit);
    if (start >= length)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${length}` },
      });
    const end = Math.min(requestedEnd ?? length - 1, length - 1) + 1;
    let at = start,
      cancelled = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: async (stream) => {
          try {
            signal?.throwIfAborted();
            const to = Math.min(at + CHUNK, end);
            await this.ensure(to);
            signal?.throwIfAborted();
            if (cancelled) return;
            const bytes = new Uint8Array(to - at);
            if (this.disk.read(bytes, at) !== bytes.length)
              throw new Error(MEDIA_RANGE_ERRORS.truncated);
            at = to;
            stream.enqueue(bytes);
            if (at >= end) stream.close();
          } catch (error) {
            if (!cancelled) stream.error(error);
          }
        },
        cancel: () => {
          cancelled = true;
        },
      }),
      {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end - 1}/${length}`,
          'Content-Length': String(end - start),
          'Accept-Ranges': 'bytes',
        },
      },
    );
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    await this.reader.cancel().catch(() => { });
    await this.queue;
    await this.disk.remove();
  }
}
export class RangeMediaCache {
  private files = new Map<string, Promise<SequentialFile>>();
  private cleaning = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    private network: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private createDisk: () => Promise<MediaDisk> = privateMediaDisk,
    private idleMs = 20000,
  ) { }
  fetch: typeof fetch = async (input, init) => {
    if (this.closed) throw new DOMException('Cancelled', 'AbortError');
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    const range = new Headers(init?.headers ?? request?.headers).get('Range');
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    const from = match ? Number(match[1]) : undefined;
    const to = match?.[2] ? Number(match[2]) : undefined;
    const validRange =
      from !== undefined &&
      Number.isSafeInteger(from) &&
      (to === undefined || (Number.isSafeInteger(to) && to >= from));
    if (validRange && this.files.has(url))
      return (await this.files.get(url)!).response(from, to, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.idleMs);
    let response: Response;
    try {
      response = await this.network(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      if (controller.signal.aborted && !signal?.aborted)
        throw new Error(MEDIA_RANGE_ERRORS.timeout, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!validRange || response.status !== 200 || !response.body)
      return response;
    // A 200 response starts at byte zero. Hand ownership to the disk cache so
    // cancelling a virtual range response does not destroy the reusable origin stream.
    signal?.removeEventListener('abort', abort);
    let file = this.files.get(url);
    if (file) {
      controller.abort();
      await response.body.cancel().catch(() => { });
    } else {
      const body = response.body;
      file = (async () => {
        const disk = await this.createDisk();
        const stored = new SequentialFile(
          response,
          disk,
          controller,
          this.idleMs,
          () => {
            if (this.files.get(url) === file) this.files.delete(url);
            // Release the failed origin body and disk file before a retry makes
            // a new source; do not keep returning the poisoned cached response.
            const cleanup = stored.close().catch(() => { });
            this.cleaning.add(cleanup);
            void cleanup.finally(() => this.cleaning.delete(cleanup));
          },
        );
        if (this.closed) {
          await stored.close();
          throw new DOMException('Cancelled', 'AbortError');
        }
        return stored;
      })();
      this.files.set(url, file);
      file.catch(() => {
        controller.abort();
        void body.cancel().catch(() => { });
        if (this.files.get(url) === file) this.files.delete(url);
      });
      // Worker inputs use one URL at a time. Keep at most two disk-backed resources
      // for refreshed addresses; no persistent media URLs or signed query strings.
      while (this.files.size > 2) {
        const [oldUrl, old] = this.files.entries().next().value!;
        this.files.delete(oldUrl);
        void old.then((f) => f.close()).catch(() => { });
      }
    }
    return (await file).response(from, to, signal);
  };
  async close() {
    this.closed = true;
    const files = [...this.files.values()];
    this.files.clear();
    await Promise.allSettled(files.map(async (f) => (await f).close()));
    await Promise.allSettled(this.cleaning);
  }
}
