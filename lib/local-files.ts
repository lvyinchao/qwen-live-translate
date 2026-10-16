import {
  archiveFilename,
  mergeArchiveSegments,
  sameArchiveUtterance,
  type ArchiveBatch,
  type ArchiveContext,
  type LocalFileStatus,
} from './archive';
import { decode64 } from './audio';
import { PrivateFiles, putBlob, type FileStore } from './file-store';
import {
  digest,
  mergeAudio,
  mergedScripts,
  pcmSize,
  streamZip,
  textDigest,
  type StoredPart,
} from './merged-audio';
import { messageError, type TranslationSegment } from './types';

type Job = {
  key: string;
  folder: string;
  context: ArchiveContext;
  revision: number;
  requestedRevision: number;
  savedRevision: number;
  count: number;
  updatedAt: number;
  automatic?: boolean;
  preferenceVersion?: number;
};
type Saved = { key: string; downloadId: number; filename: string; at: number };
export interface ArchiveStorageSummary {
  bytes: number;
  files: number;
  parts: number;
  jobs: number;
  orphanBytes: number;
}
const jobKey = (context: ArchiveContext) =>
  JSON.stringify([
    context.mediaId,
    context.trackId,
    context.language,
    context.voice,
  ]);
export class LocalFiles {
  private dbPromise?: Promise<IDBDatabase>;
  private initialized?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private draining?: Promise<void>;
  private error?: string;
  private autoSave = false;
  private preferenceVersion = 0;
  private storageVersion = 0;
  private clearing = false;
  private clearOperation?: Promise<void>;
  private pinnedPaths = new Set<string>();
  setAutoSave(enabled: boolean) {
    if (this.autoSave !== enabled) this.preferenceVersion++;
    this.autoSave = enabled;
  }
  private canDownload(job: Job) {
    return (
      !this.clearing &&
      job.requestedRevision > job.savedRevision &&
      (job.automatic === false ||
        (this.autoSave && job.preferenceVersion === this.preferenceVersion))
    );
  }
  constructor(
    private download: (url: string, filename: string) => Promise<number>,
    private notify: (status: LocalFileStatus) => void = () => { },
    private name = 'qwen-video-dub-files',
    private disk: FileStore = new PrivateFiles(),
  ) { }
  private db() {
    return (this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pending'))
          db.createObjectStore('pending', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('saved'))
          db.createObjectStore('saved', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('jobs'))
          db.createObjectStore('jobs', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('parts'))
          db.createObjectStore('parts', { keyPath: 'key' }).createIndex(
            'job',
            'job',
          );
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  private async all<T>(store: string, key?: IDBValidKey): Promise<T[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const target = db.transaction(store).objectStore(store);
      const request =
        key === undefined ? target.getAll() : target.index('job').getAll(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async get<T>(
    store: string,
    key: IDBValidKey,
  ): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async mutate(stores: string[], fn: (tx: IDBTransaction) => void) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      fn(tx);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.then(fn);
    this.writes = next.catch(() => { });
    return next;
  }
  private initialize() {
    return (this.initialized ??= (async () => {
      // Migrate old queued audio one window at a time. Never delete its only copy
      // until WAV files and the new metadata transaction have both committed.
      const db = await this.db();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const r = db.transaction('pending').objectStore('pending').getAllKeys();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const key of keys) {
        const batch = await this.get<ArchiveBatch>('pending', key);
        if (batch) await this.saveParts(batch.context, batch.segments,
          batch.ready ? { start: batch.start, end: batch.end } : undefined);
        await this.mutate(['pending'], (tx) =>
          tx.objectStore('pending').delete(key),
        );
      }
      // A previously failed final download is retried only on an explicit user
      // retry. Merely opening the extension must never start a download burst.
      const jobs = await this.all<Job>('jobs');
      for (const job of jobs) {
        const kept: StoredPart[] = [], removed: string[] = [];
        const parts = (await this.all<StoredPart>('parts', job.key))
          .sort((a, b) => (a.storedAt ?? 0) - (b.storedAt ?? 0));
        for (const part of parts) {
          const duplicate = kept.findIndex((old) => sameArchiveUtterance(old, part));
          if (duplicate < 0) kept.push(part);
          else {
            removed.push(kept[duplicate]!.key);
            kept[duplicate] = part;
          }
        }
        if (removed.length) {
          job.count = kept.length;
          job.revision++;
          await this.mutate(['jobs', 'parts'], (tx) => {
            for (const key of removed) tx.objectStore('parts').delete(key);
            tx.objectStore('jobs').put(job);
          });
        }
      }
      await this.mutate(['jobs'], (tx) => {
        for (const job of jobs)
          if (job.requestedRevision > job.savedRevision)
            tx.objectStore('jobs').put({
              ...job,
              requestedRevision: job.savedRevision,
            });
      });
      await this.collect();
    })());
  }
  private async saveParts(
    context: ArchiveContext,
    segments: TranslationSegment[],
    completedWindow?: { start: number; end: number },
  ) {
    if (!segments.length && !completedWindow) return;
    const key = jobKey(context);
    const previous = await this.get<Job>('jobs', key);
    const folder = previous?.folder ?? (await textDigest(key)).slice(0, 24);
    const job: Job = previous ?? {
      key,
      folder,
      context,
      revision: 0,
      requestedRevision: 0,
      savedRevision: 0,
      count: 0,
      updatedAt: Date.now(),
    };
    const existing = await this.all<StoredPart>('parts', key);
    const updates: StoredPart[] = [];
    const removed = new Map<string, StoredPart>();
    const created: string[] = [];
    const keep = new Set<string>();
    try {
      for (const segment of mergeArchiveSegments([], segments)) {
        if (
          segment.mediaId !== context.mediaId ||
          segment.language !== context.language ||
          segment.voice !== context.voice ||
          !Number.isFinite(segment.start) ||
          !Number.isFinite(segment.end) ||
          segment.start < 0 ||
          segment.end <= segment.start
        )
          throw new Error('本地译音片段信息无效');
        // Keep the old stable key when a retried utterance shifts slightly. Speaker
        // IDs are included for new parts so simultaneous speakers do not overwrite.
        const old = existing.find((part) => sameArchiveUtterance(part, segment));
        const partKey = old?.key ?? JSON.stringify([
          key, segment.start, segment.end, segment.speaker ?? null,
        ]);
        keep.add(partKey);
        const bytes = decode64(segment.audio),
          audioHash = await digest(bytes);
        const fingerprint = await textDigest(
          JSON.stringify([
            audioHash,
            segment.sourceText,
            segment.text,
            segment.speaker ?? null,
          ]),
        );
        if (
          old?.fingerprint === fingerprint &&
          old.start === segment.start && old.end === segment.end
        ) continue;
        const file = new Blob([bytes], { type: 'audio/wav' }),
          size = await pcmSize(file);
        const path = `${folder}/parts/${Math.round(segment.start * 1000)}-${Math.round(segment.end * 1000)}-${audioHash.slice(0, 24)}.wav`;
        if (!existing.some((part) => part.path === path)) {
          created.push(path);
          await putBlob(this.disk, path, file);
        }
        const { audio: _, ...metadata } = segment;
        updates.push({
          ...metadata,
          key: partKey,
          job: key,
          path,
          fingerprint,
          samples: size / 2,
          storedAt: Date.now(),
        });
        job.revision++;
        if (!old) job.count++;
        for (const duplicate of existing)
          if (duplicate.key !== partKey && sameArchiveUtterance(duplicate, segment)) {
            if (!removed.has(duplicate.key)) job.count--;
            removed.set(duplicate.key, duplicate);
          }
        if (old && old.path !== path) removed.set(old.key, old);
      }
      // Only a fully translated window is authoritative. Streaming updates and
      // cache hits may contain a subset of speakers/utterances, so never prune then.
      if (completedWindow)
        for (const old of existing)
          if (!keep.has(old.key) && old.start >= completedWindow.start - 0.03 &&
            old.end <= completedWindow.end + 0.03) {
            if (!removed.has(old.key)) job.count--;
            removed.set(old.key, old);
          }
      if (!updates.length && !removed.size) return;
      if (!updates.length) job.revision++;
      job.context = context;
      job.updatedAt = Date.now();
      await this.mutate(['jobs', 'parts'], (tx) => {
        for (const old of removed.values()) tx.objectStore('parts').delete(old.key);
        for (const p of updates) tx.objectStore('parts').put(p);
        tx.objectStore('jobs').put(job);
      });
      const retained = new Set((await this.all<StoredPart>('parts', key)).map((part) => part.path));
      for (const old of removed.values())
        if (!retained.has(old.path) && !this.pinnedPaths.has(old.path))
          await this.disk.remove(old.path).catch(() => { });
    } catch (error) {
      // A failed metadata transaction must not leave freshly written WAVs behind.
      const referenced = new Set((await this.all<StoredPart>('parts')).map((p) => p.path));
      for (const path of created)
        if (!referenced.has(path) && !this.pinnedPaths.has(path))
          await this.disk.remove(path).catch(() => { });
      throw error;
    }
  }
  /** Must run under the write queue, or during initialization before callers enter it. */
  private async collect() {
    if (!this.disk.list) return;
    const referenced = new Set((await this.all<StoredPart>('parts')).map((p) => p.path));
    for (const file of await this.disk.list())
      if (!referenced.has(file.path) && !this.pinnedPaths.has(file.path))
        await this.disk.remove(file.path);
  }
  async summary(): Promise<ArchiveStorageSummary> {
    await this.initialize();
    return this.serialize(async () => {
      const [parts, jobs] = await Promise.all([
        this.all<StoredPart>('parts'), this.all<Job>('jobs'),
      ]);
      const physical = this.disk.list
        ? await this.disk.list()
        : await Promise.all(parts.map(async (p) => ({
          path: p.path, size: (await this.disk.get(p.path)).size,
        })));
      const references = new Set([...parts.map((p) => p.path), ...this.pinnedPaths]);
      return {
        bytes: physical.reduce((sum, file) => sum + file.size, 0),
        files: physical.length,
        parts: parts.length,
        jobs: jobs.length,
        orphanBytes: physical.reduce((sum, file) => sum + (references.has(file.path) ? 0 : file.size), 0),
      };
    });
  }
  async gc() {
    await this.initialize();
    await this.serialize(() => this.collect());
    return this.summary();
  }
  /** Explicitly clears browser-private archives; completed Chrome downloads stay untouched. */
  clear(): Promise<void> {
    if (this.clearOperation) return this.clearOperation;
    this.clearing = true;
    this.storageVersion++;
    this.preferenceVersion++;
    this.clearOperation = (async () => {
      await this.initialize();
      // A dispatched download can finish. Queued automatic/manual merges cannot start.
      await this.draining;
      await this.serialize(async () => {
        const parts = await this.all<StoredPart>('parts');
        const paths = this.disk.list
          ? (await this.disk.list()).map((file) => file.path)
          : parts.map((part) => part.path);
        await this.mutate(['jobs', 'parts', 'saved', 'pending'], (tx) => {
          for (const store of ['jobs', 'parts', 'saved', 'pending']) tx.objectStore(store).clear();
        });
        const deleted = await Promise.allSettled(paths.map((path) => this.disk.remove(path)));
        const failure = deleted.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        this.error = undefined;
      });
    })().finally(async () => {
      this.clearing = false;
      this.clearOperation = undefined;
      await this.publish();
    });
    return this.clearOperation;
  }
  async status(): Promise<LocalFileStatus> {
    await this.initialize();
    await this.writes;
    const [jobs, saved] = await Promise.all([
      this.all<Job>('jobs'),
      this.all<Saved>('saved'),
    ]);
    const last = saved.sort((a, b) => b.at - a.at)[0];
    return {
      pending: jobs.filter((j) => j.revision > j.savedRevision).length,
      staged: jobs.reduce((n, j) => n + j.count, 0),
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
    if (!this.autoSave || this.clearing) return;
    const version = this.preferenceVersion;
    const storageVersion = this.storageVersion;
    await this.initialize();
    await this.serialize(() =>
      !this.clearing && storageVersion === this.storageVersion &&
        this.autoSave && version === this.preferenceVersion
        ? this.saveParts(context, segments, ready ? { start, end } : undefined)
        : Promise.resolve(),
    );
    await this.publish();
  }
  // Quiet checkpoint: seeks, startup and completed input windows only persist
  // chunks; none of these actions may invoke chrome.downloads.
  async flush() {
    await this.initialize();
    await this.writes;
    await this.publish();
  }
  async finish(context?: ArchiveContext, automatic = true) {
    if (this.clearing || (automatic && !this.autoSave)) return;
    const version = this.preferenceVersion;
    const storageVersion = this.storageVersion;
    await this.initialize();
    await this.serialize(async () => {
      if (this.clearing || storageVersion !== this.storageVersion ||
        (automatic && (!this.autoSave || version !== this.preferenceVersion)))
        return;
      const jobs = context
        ? [await this.get<Job>('jobs', jobKey(context))]
        : await this.all<Job>('jobs');
      await this.mutate(['jobs'], (tx) => {
        for (const job of jobs)
          if (job && job.revision > job.savedRevision)
            tx.objectStore('jobs').put({
              ...job,
              requestedRevision: job.revision,
              automatic,
              preferenceVersion: version,
            });
      });
    });
    if (!this.error && !this.clearing) void this.drain();
    await this.publish();
  }
  async retry() {
    this.error = undefined;
    await this.finish(undefined, false);
  }
  async failed(error: unknown) {
    this.error = messageError(error);
    try {
      await this.publish();
    } catch {
      this.notify({ pending: 0, saved: 0, saving: false, error: this.error });
    }
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
          (await this.all<Job>('jobs')).some((j) => this.canDownload(j))
        )
          void this.drain();
      });
    return this.draining;
  }
  private async run() {
    while (!this.error) {
      await this.writes;
      const job = (await this.all<Job>('jobs')).find((j) =>
        this.canDownload(j),
      );
      if (!job) return;
      // Snapshot metadata under the same queue as capture. WAV filenames are
      // content addressed, so later captures cannot mutate an in-progress merge.
      const snapshot = await this.serialize(async () => {
        const snapshot = {
          job: (await this.get<Job>('jobs', job.key))!,
          parts: (await this.all<StoredPart>('parts', job.key)).sort(
            (a, b) => a.start - b.start || a.end - b.end,
          ),
        };
        for (const part of snapshot.parts) this.pinnedPaths.add(part.path);
        return snapshot;
      });
      const revision = snapshot.job.revision,
        parts = snapshot.parts;
      if (!parts.length) return;
      try {
        const fingerprint = await textDigest(
          JSON.stringify([
            snapshot.job.context,
            parts.map((p) => [p.start, p.end, p.fingerprint]),
          ]),
        );
        const savedKey = JSON.stringify([job.key, fingerprint]);
        const old = await this.get<Saved>('saved', savedKey);
        const mergedPath = `${job.folder}/merged-${fingerprint.slice(0, 24)}.wav`,
          zipPath = `${job.folder}/merged-${fingerprint.slice(0, 24)}.zip`;
        this.pinnedPaths.add(mergedPath);
        this.pinnedPaths.add(zipPath);
        const base = await archiveFilename({
          key: job.key,
          context: snapshot.job.context,
          start: parts[0]!.start,
          end: Math.max(...parts.map((p) => p.end)),
          segments: [],
          ready: true,
        });
        const filename = (
          old?.filename ??
          base.replace(/\.zip$/, `-merged-${fingerprint.slice(0, 12)}.zip`)
        ).replace(/^Qwen Video Dub\//, 'TimbraDub/');
        let id = old?.downloadId;
        try {
          if (id === undefined) {
            await this.publish();
            await mergeAudio(this.disk, mergedPath, parts);
            await streamZip(this.disk, zipPath, [
              { name: 'combined.wav', blob: await this.disk.get(mergedPath) },
              ...mergedScripts(snapshot.job.context, parts),
            ]);
            const url = URL.createObjectURL(await this.disk.get(zipPath));
            try {
              // An automatic merge may have been preparing when the user switched
              // saving off. Already-started downloads can finish; no new one starts.
              if (!this.canDownload(snapshot.job)) return;
              id = await this.download(url, filename);
            } finally {
              URL.revokeObjectURL(url);
            }
          }
          await this.serialize(async () => {
            const current = (await this.get<Job>('jobs', job.key))!;
            await this.mutate(['jobs', 'saved'], (tx) => {
              tx.objectStore('jobs').put({
                ...current,
                savedRevision: Math.max(current.savedRevision, revision),
              });
              tx.objectStore('saved').put({
                key: savedKey,
                downloadId: id,
                filename,
                at: Date.now(),
              });
            });
          });
        } finally {
          // Source chunks remain durable. Temporary merged files are reproducible.
          await this.disk.remove(mergedPath).catch(() => { });
          await this.disk.remove(zipPath).catch(() => { });
          this.pinnedPaths.delete(mergedPath);
          this.pinnedPaths.delete(zipPath);
        }
      } finally {
        for (const part of parts) this.pinnedPaths.delete(part.path);
        await this.serialize(() => this.collect());
      }
    }
  }
}
