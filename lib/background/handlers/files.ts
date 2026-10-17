import { AppError } from '../../errors';
import type { Result } from '../../messages';
import { publicSettings } from '../../security';
import type { BackgroundContext } from '../context';
import type { Route, RouteGroup } from '../router';

const READ_FILES = '不允许网页读取本地保存内容';
const UNAVAILABLE = '本地保存暂不可用';
const DOWNLOAD_TIMEOUT_MS = 90000;

/** Forwards to the offscreen document and unwraps its `Result`. */
async function offscreenValue<T>(ctx: BackgroundContext, type: string): Promise<T> {
  await ctx.ensureOffscreen();
  const result = await ctx.toOffscreen<Result<T> | undefined>(type);
  if (!result?.ok) throw new Error(result?.error ?? UNAVAILABLE);
  return result.value;
}

/** Only extension-owned blobs saved as `TimbraDub/**.zip`, without traversal. */
export function validDownload(url: string, filename: string, extensionRoot: string) {
  return (
    url.startsWith(`blob:${extensionRoot}`) &&
    filename.startsWith('TimbraDub/') &&
    filename.endsWith('.zip') &&
    !/[\\\x00-\x1f]/.test(filename) &&
    !filename.split('/').some((p) => !p || p === '.' || p === '..')
  );
}

/** Resolves with the download id once Chrome reports the file complete. */
function download(url: string, filename: string) {
  return new Promise<number>((resolve, reject) => {
    let id: number | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(changed);
    };
    const changed = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        resolve(id);
      }
      if (delta.state?.current === 'interrupted') {
        cleanup();
        reject(new Error('本地文件保存中断，请重试'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('本地文件保存超时，请重试'));
    }, DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.onChanged.addListener(changed);
    void chrome.downloads
      .download({ url, filename, saveAs: false, conflictAction: 'uniquify' })
      .then(async (value) => {
        id = value;
        const [item] = await chrome.downloads.search({ id });
        if (item?.state === 'complete') {
          cleanup();
          resolve(id);
        } else if (item?.state === 'interrupted') {
          cleanup();
          reject(new Error('本地文件保存中断，请重试'));
        }
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

export const fileRoutes: RouteGroup<
  | 'files:set-enabled'
  | 'files:status'
  | 'files:merge'
  | 'files:retry'
  | 'files:show'
  | 'files:download'
  | 'storage:summary'
  | 'cache:clear'
  | 'media:clear'
  | 'archives:clear'
> = {
  'files:set-enabled': {
    privileged: '不允许网页修改配置',
    handle: ({ ctx, message }) =>
      ctx.transitions.run(async () => {
        const next = { ...(await ctx.loadSettings()), autoSaveFiles: message.enabled === true };
        await chrome.storage.local.set({ settings: next });
        await ctx.ensureOffscreen();
        const configured = await ctx.toOffscreen<Result<unknown> | undefined>('files:configure');
        if (!configured?.ok) throw new Error(configured?.error ?? UNAVAILABLE);
        return publicSettings(await ctx.loadSettings());
      }),
  },
  'files:status': { privileged: READ_FILES, handle: ({ ctx }) => offscreenValue(ctx, 'files:status') },
  'files:merge': { privileged: READ_FILES, handle: ({ ctx }) => offscreenValue(ctx, 'files:merge') },
  'files:retry': { privileged: READ_FILES, handle: ({ ctx }) => offscreenValue(ctx, 'files:retry') },
  'files:show': {
    privileged: READ_FILES,
    handle: async ({ message }) => {
      const id = Number(message.id);
      if (!Number.isInteger(id)) throw new Error('本地文件不存在');
      const [item] = await chrome.downloads.search({ id });
      if (!item || item.byExtensionId !== chrome.runtime.id) throw new Error('本地文件不存在');
      await chrome.downloads.show(id);
      return true;
    },
  },
  'files:download': {
    handle: ({ ctx, message, sender }) => {
      if (!ctx.trusted(sender) || sender.url !== chrome.runtime.getURL('offscreen.html'))
        throw new AppError('forbidden', '不允许网页保存文件');
      const url = String(message.url),
        filename = String(message.filename);
      if (!validDownload(url, filename, chrome.runtime.getURL('')))
        throw new Error('本地保存路径无效');
      return download(url, filename);
    },
  },
  'storage:summary': {
    privileged: '不允许网页清理缓存',
    handle: ({ ctx }) => offscreenValue(ctx, 'storage:summary'),
  },
  'cache:clear': clearRoute('cache:clear'),
  'media:clear': clearRoute('media:clear'),
  'archives:clear': clearRoute('archives:clear'),
};

function clearRoute<K extends 'cache:clear' | 'media:clear' | 'archives:clear'>(type: K): Route<K> {
  return {
    privileged: '不允许网页清理缓存',
    handle: ({ ctx }) =>
      ctx.transitions.run(async () => {
        if (ctx.session) throw new Error('请先停止翻译，再清理缓存');
        return offscreenValue(ctx, type);
      }),
  };
}
