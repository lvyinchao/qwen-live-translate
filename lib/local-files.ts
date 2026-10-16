import {
  archiveFilename,
  mergeArchiveSegments,
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
  setAutoSave(enabled: boolean) {
    if (this.autoSave !== enabled) this.preferenceVersion++;
    this.autoSave = enabled;
  }
  private canDownload(job: Job) {
    return (
      job.requestedRevision > job.savedRevision &&
      (job.automatic === false ||
        (this.autoSave && job.preferenceVersion === this.preferenceVersion))
    );
  }
  constructor(
    private download: (url: string, filename: string) => Promise<number>,
    private notify: (status: LocalFileStatus) => void = () => {},
    private name = 'qwen-video-dub-files',
    private disk: FileStore = new PrivateFiles(),
  ) {}
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
    this.writes = next.catch(() => {});
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
        if (batch) await this.saveParts(batch.context, batch.segments);
        await this.mutate(['pending'], (tx) =>
          tx.objectStore('pending').delete(key),
        );
      }
      // A previously failed final download is retried only on an explicit user
      // retry. Merely opening the extension must never start a download burst.
      const jobs = await this.all<Job>('jobs');
      await this.mutate(['jobs'], (tx) => {
        for (const job of jobs)
          if (job.requestedRevision > job.savedRevision)
            tx.objectStore('jobs').put({
              ...job,
              requestedRevision: job.savedRevision,
            });
      });
    })());
  }
  private async saveParts(
    context: ArchiveContext,
    segments: TranslationSegment[],
  ) {
    if (!segments.length) return;
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
    const updates: StoredPart[] = [];
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
      const partKey = JSON.stringify([key, segment.start, segment.end]);
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
      const old = await this.get<StoredPart>('parts', partKey);
      if (old?.fingerprint === fingerprint) continue;
      const file = new Blob([bytes], { type: 'audio/wav' }),
        size = await pcmSize(file);
      const path = `${folder}/parts/${Math.round(segment.start * 1000)}-${Math.round(segment.end * 1000)}-${audioHash.slice(0, 24)}.wav`;
      await putBlob(this.disk, path, file);
      const { audio: _, ...metadata } = segment;
      updates.push({
        ...metadata,
        key: partKey,
        job: key,
        path,
        fingerprint,
        samples: size / 2,
      });
      job.revision++;
      if (!old) job.count++;
    }
    if (!updates.length) return;
    job.context = context;
    job.updatedAt = Date.now();
    await this.mutate(['jobs', 'parts'], (tx) => {
      for (const p of updates) tx.objectStore('parts').put(p);
      tx.objectStore('jobs').put(job);
    });
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
    _start: number,
    _end: number,
    segments: TranslationSegment[],
    _ready = false,
  ) {
    if (!this.autoSave) return;
    const version = this.preferenceVersion;
    await this.initialize();
    await this.serialize(() =>
      this.autoSave && version === this.preferenceVersion
        ? this.saveParts(context, segments)
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
    if (automatic && !this.autoSave) return;
    const version = this.preferenceVersion;
    await this.initialize();
    await this.serialize(async () => {
      if (automatic && (!this.autoSave || version !== this.preferenceVersion))
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
    if (!this.error) void this.drain();
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
      const snapshot = await this.serialize(async () => ({
        job: (await this.get<Job>('jobs', job.key))!,
        parts: (await this.all<StoredPart>('parts', job.key)).sort(
          (a, b) => a.start - b.start || a.end - b.end,
        ),
      }));
      const revision = snapshot.job.revision,
        parts = snapshot.parts;
      if (!parts.length) return;
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
      const base = await archiveFilename({
        key: job.key,
        context: snapshot.job.context,
        start: parts[0]!.start,
        end: Math.max(...parts.map((p) => p.end)),
        segments: [],
        ready: true,
      });
      const filename =
        old?.filename ??
        base.replace(/\.zip$/, `-merged-${fingerprint.slice(0, 12)}.zip`);
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
        await this.disk.remove(mergedPath).catch(() => {});
        await this.disk.remove(zipPath).catch(() => {});
      }
    }
  }
}
