export interface FileSink {
  write(data: Uint8Array<ArrayBuffer> | Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface FileStore {
  get(path: string): Promise<Blob>;
  create(path: string): Promise<FileSink>;
  remove(path: string): Promise<void>;
}
export class PrivateFiles implements FileStore {
  private async parent(path: string, create: boolean) {
    const pieces = path.split('/');
    if (pieces.some((p) => !p || p === '.' || p === '..' || /[\\\x00]/.test(p)))
      throw new Error('本地保存路径无效');
    let directory = await navigator.storage.getDirectory();
    directory = await directory.getDirectoryHandle('qwen-video-dub', {
      create: true,
    });
    for (const name of pieces.slice(0, -1))
      directory = await directory.getDirectoryHandle(name, { create });
    return { directory, name: pieces.at(-1)! };
  }
  async get(path: string): Promise<Blob> {
    const { directory, name } = await this.parent(path, false);
    return (await directory.getFileHandle(name)).getFile();
  }
  async create(path: string): Promise<FileSink> {
    const { directory, name } = await this.parent(path, true);
    return (
      await directory.getFileHandle(name, { create: true })
    ).createWritable();
  }
  async remove(path: string) {
    const { directory, name } = await this.parent(path, false);
    await directory.removeEntry(name);
  }
}
export async function writeBlob(sink: FileSink, blob: Blob) {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await sink.write(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
}
export async function putBlob(store: FileStore, path: string, blob: Blob) {
  const sink = await store.create(path);
  try {
    await writeBlob(sink, blob);
    await sink.close();
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}
