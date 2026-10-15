import { CACHE_LIMIT, type TranslationSegment } from './types';
import { mergeCoverage, type Coverage } from './timeline';

type RecordItem = {
  key: string;
  mediaId: string;
  language: string;
  voice: string;
  start: number;
  end: number;
  touched: number;
  bytes: number;
  segments: TranslationSegment[];
};
type IndexItem = Omit<RecordItem, 'segments'>;
const keyFor = (
  mediaId: string,
  language: string,
  voice: string,
  start: number,
  end: number,
) => JSON.stringify([mediaId, language, voice, start, end]);
export class SegmentCache {
  private dbPromise?: Promise<IDBDatabase>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private limit = CACHE_LIMIT,
    private name = 'qwen-video-dub',
  ) {}
  private db() {
    return (this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('windows'))
          db.createObjectStore('windows', { keyPath: 'key' });
        const index = db.createObjectStore('metadata', { keyPath: 'key' });
        // Migrate preview caches without materializing all audio in memory.
        const cursor = request.transaction!.objectStore('windows').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const { segments: _, ...metadata } = row.value as RecordItem;
          index.put(metadata);
          row.continue();
        };
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  private async metadata(): Promise<IndexItem[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const req = db.transaction('metadata').objectStore('metadata').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async mutate(
    callback: (windows: IDBObjectStore, index: IDBObjectStore) => void,
  ) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['windows', 'metadata'], 'readwrite');
      callback(tx.objectStore('windows'), tx.objectStore('metadata'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async put(
    mediaId: string,
    language: string,
    voice: string,
    range: Coverage,
    segments: TranslationSegment[],
  ) {
    const operation = this.writes.then(async () => {
      const bytes = segments.reduce(
        (sum, s) =>
          sum +
          s.audio.length +
          (s.sourceText.length + s.text.length) * 2 +
          512,
        256,
      );
      const record: RecordItem = {
        key: keyFor(mediaId, language, voice, range.start, range.end),
        mediaId,
        language,
        voice,
        ...range,
        segments,
        bytes,
        touched: Date.now(),
      };
      if (bytes > this.limit) throw new Error('当前译音片段超过缓存上限');
      const old = (await this.metadata())
        .filter((r) => r.key !== record.key)
        .sort((a, b) => a.touched - b.touched);
      let total = old.reduce((sum, r) => sum + r.bytes, bytes);
      const remove: string[] = [];
      for (const item of old) {
        if (total <= this.limit) break;
        remove.push(item.key);
        total -= item.bytes;
      }
      const { segments: _, ...metadata } = record;
      await this.mutate((store, index) => {
        for (const key of remove) {
          store.delete(key);
          index.delete(key);
        }
        store.put(record);
        index.put(metadata);
      });
    });
    this.writes = operation.catch(() => {});
    await operation;
  }
  async load(
    mediaId: string,
    language: string,
    voice: string,
  ): Promise<{ segments: TranslationSegment[]; ranges: Coverage[] }> {
    await this.writes;
    const records = (await this.metadata()).filter(
      (r) =>
        r.mediaId === mediaId && r.language === language && r.voice === voice,
    );
    const db = await this.db();
    const windows = await new Promise<RecordItem[]>((resolve, reject) => {
      const tx = db.transaction('windows'),
        store = tx.objectStore('windows'),
        out: RecordItem[] = [];
      for (const record of records) {
        const req = store.get(record.key);
        req.onsuccess = () => {
          if (req.result) out.push(req.result);
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
    if (records.length)
      await this.mutate((_, index) =>
        records.forEach((r) => {
          const req = index.get(r.key);
          req.onsuccess = () => {
            if (req.result) index.put({ ...req.result, touched: Date.now() });
          };
        }),
      );
    const segments = [
      ...new Map(
        windows
          .flatMap((r) => r.segments)
          .map((s) => [`${s.start}:${s.end}`, s]),
      ).values(),
    ].sort((a, b) => a.start - b.start);
    return {
      segments,
      ranges: mergeCoverage(
        windows.map((r) => ({ start: r.start, end: r.end })),
      ),
    };
  }
  async clear() {
    await this.writes;
    await this.mutate((store, index) => {
      store.clear();
      index.clear();
    });
  }
  async size() {
    await this.writes;
    return (await this.metadata()).reduce((sum, r) => sum + r.bytes, 0);
  }
}
