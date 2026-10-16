export interface FileSink {
  write(data: Uint8Array<ArrayBuffer> | Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface FileStore {
  get(path: string): Promise<Blob>;
  create(path: string): Promise<FileSink>;
  remove(path: string): Promise<void>;
  /** Enumerates only this archive store, never the user's Downloads folder. */
  list?(): Promise<{ path: string; size: number }[]>;
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
  async list() {
    const files: { path: string; size: number }[] = [];
    let root: FileSystemDirectoryHandle;
    try {
      root = await (await navigator.storage.getDirectory()).getDirectoryHandle(
        'qwen-video-dub',
      );
    } catch (error) {
      if ((error as DOMException).name === 'NotFoundError') return files;
      throw error;
    }
    const walk = async (directory: FileSystemDirectoryHandle, prefix: string) => {
      const entries = directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      };
      for await (const [name, handle] of entries.entries()) {
        const path = prefix + name;
        if (handle.kind === 'directory')
          await walk(handle as FileSystemDirectoryHandle, path + '/');
        else {
          try {
            files.push({
              path,
              size: (await (handle as FileSystemFileHandle).getFile()).size,
            });
          } catch (error) {
            // A completed merge may remove its temporary File while enumerating.
            if ((error as DOMException).name !== 'NotFoundError') throw error;
          }
        }
      }
    };
    await walk(root, '');
    return files;
  }
}
export async function writeBlob(sink: FileSink, blob: Blob) {
  const reader = blob.stream().getReader();
  try {
    for (; ;) {
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
    await sink.abort().catch(() => { });
    throw error;
  }
}
