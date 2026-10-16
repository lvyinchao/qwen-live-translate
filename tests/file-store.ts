import type { FileStore, FileSink } from '../lib/file-store';
export class MemoryFiles implements FileStore {
  files = new Map<string, Blob>();
  async get(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error('missing file');
    return value;
  }
  async create(path: string): Promise<FileSink> {
    const parts: BlobPart[] = [];
    return {
      write: async (value) => {
        parts.push(value instanceof Blob ? value : new Uint8Array(value));
      },
      close: async () => {
        this.files.set(path, new Blob(parts));
      },
      abort: async () => {},
    };
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async list() {
    return [...this.files].map(([path, blob]) => ({ path, size: blob.size }));
  }
}
