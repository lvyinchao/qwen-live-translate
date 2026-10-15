import {
  archiveEntries,
  archiveFilename,
  archiveKey,
  mergeArchiveSegments,
  zipEntries,
  type ArchiveBatch,
  type ArchiveContext,
  type LocalFileStatus,
} from './archive';
import { messageError, type TranslationSegment } from './types';

type PendingBatch = ArchiveBatch & { revision: number; bytes: number };
type SavedBatch = {
  key: string;
  batchKey: string;
  downloadId: number;
  filename: string;
  at: number;
  fingerprint: string;
};
export class LocalFiles {
  private dbPromise?: Promise<IDBDatabase>;
  private writes: Promise<unknown> = Promise.resolve();
  private draining?: Promise<void>;
  private error?: string;
  constructor(
    private download: (url: string, filename: string) => Promise<number>,
    private notify: (status: LocalFileStatus) => void = () => {},
    private name = 'qwen-video-dub-files',
  ) {}
  private db() {
    return (this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('pending', { keyPath: 'key' });
        request.result.createObjectStore('saved', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  private async read<T>(name: string): Promise<T[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async mutate(
    fn: (pending: IDBObjectStore, saved: IDBObjectStore) => void,
  ) {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['pending', 'saved'], 'readwrite');
      fn(tx.objectStore('pending'), tx.objectStore('saved'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.then(fn);
    this.writes = next.catch(() => {});
    return next;
  }
  async status(): Promise<LocalFileStatus> {
    await this.writes;
    const [pending, saved] = await Promise.all([
      this.read<PendingBatch>('pending'),
      this.read<SavedBatch>('saved'),
    ]);
    const last = saved.sort((a, b) => b.at - a.at)[0];
    return {
      pending: pending.length,
      saved: saved.length,
      saving: !!this.draining,
      lastDownloadId: last?.downloadId,
      lastFilename: last?.filename,
      error: this.error,
    };
  }
  private async publish() {
    this.notify(await this.status());
  }
  async capture(
    context: ArchiveContext,
    start: number,
    end: number,
    segments: TranslationSegment[],
    ready = false,
  ) {
    await this.serialize(async () => {
      const key = archiveKey(context, start, end);
      const pending = await this.read<PendingBatch>('pending');
      const existing = pending.find((p) => p.key === key);
      if (!existing && !segments.length) return;
      const nextSegments = mergeArchiveSegments(
        existing?.segments ?? [],
        segments,
      );
      const bytes = nextSegments.reduce(
        (n, s) =>
          n + s.audio.length + (s.text.length + s.sourceText.length) * 2 + 512,
        0,
      );
      if (
        pending
          .filter((p) => p.key !== key)
          .reduce((n, p) => n + p.bytes, bytes) >
        128 * 1024 * 1024
      )
        throw new Error('本地保存待处理内容已满，请先重试保存');
      await this.mutate((store) =>
        store.put({
          key,
          context,
          start,
          end,
          segments: nextSegments,
          ready: ready || existing?.ready || false,
          bytes,
          revision: (existing?.revision ?? 0) + 1,
        }),
      );
    });
    await this.publish();
    if (ready && !this.error) void this.drain();
  }
  // Complete utterances survive seeks, stopping, cache eviction and a restart.
  async flush() {
    await this.serialize(async () => {
      const pending = await this.read<PendingBatch>('pending');
      await this.mutate((store) =>
        pending.forEach((p) => store.put({ ...p, ready: true })),
      );
    });
    if (!this.error) void this.drain();
    await this.publish();
  }
  async retry() {
    this.error = undefined;
    await this.flush();
  }
  async failed(error: unknown) {
    this.error = messageError(error);
    await this.publish();
  }
  private drain() {
    if (this.draining) return this.draining;
    this.draining = this.run()
      .catch((error) => {
        this.error = messageError(error);
      })
      .finally(async () => {
        this.draining = undefined;
        await this.publish();
        if (
          !this.error &&
          (await this.read<PendingBatch>('pending')).some((p) => p.ready)
        )
          void this.drain();
      });
    return this.draining;
  }
  private async run() {
    while (!this.error) {
      await this.writes;
      const next = (await this.read<PendingBatch>('pending')).find(
        (p) => p.ready,
      );
      if (!next) return;
      await this.publish();
      const baseFilename = await archiveFilename(next);
      const bytes = zipEntries(archiveEntries(next));
      const fingerprint = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      const previous = (await this.read<SavedBatch>('saved')).find(
        (s) =>
          (s.batchKey ?? s.key) === next.key && s.fingerprint === fingerprint,
      );
      // A stopped window may be saved again with more/different utterances.
      // Keep earlier audio files instead of overwriting a partial archive.
      const filename =
        previous?.filename ??
        baseFilename.replace(/\.zip$/, `-${fingerprint.slice(0, 12)}.zip`);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: 'application/zip' }),
      );
      try {
        const downloadId = previous
          ? previous.downloadId
          : await this.download(url, filename);
        await this.serialize(async () => {
          const current = (await this.read<PendingBatch>('pending')).find(
            (p) => p.key === next.key,
          );
          await this.mutate((pending, saved) => {
            // A retry/seek may have added utterances while the file was saving.
            if (current?.revision === next.revision) pending.delete(next.key);
            saved.put({
              key: JSON.stringify([next.key, fingerprint]),
              batchKey: next.key,
              downloadId,
              filename,
              fingerprint,
              at: Date.now(),
            });
          });
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }
}
