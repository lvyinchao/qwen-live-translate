import DecodeWorker from '../../workers/decode?worker';
import { SegmentCache } from '../../lib/cache';
import { LocalFiles } from '../../lib/local-files';
import { archiveContext } from '../../lib/archive';
import { translateWindow } from '../../lib/qwen';
import { PlaybackEngine } from '../../lib/playback-engine';
import { createBackgroundRpc } from '../../lib/background-rpc';
import { mergeCaptionPreferences } from '../../lib/captions';
import { closeDecodeWorker } from '../../lib/worker-lifecycle';
import { cleanupMediaTemps, mediaTempSummary } from '../../lib/range-media';
import { endpoint } from '../../lib/security';
import {
  messageError,
  CACHE_LIMIT,
  type Envelope,
  type PlaybackSession,
  type Settings,
} from '../../lib/types';

const cache = new SegmentCache();
const bg = createBackgroundRpc((message) => chrome.runtime.sendMessage(message));
const files = new LocalFiles(
  (url, filename) => bg('files:download', { url, filename }),
  (status) => {
    void chrome.runtime
      .sendMessage({ type: 'files:updated', status })
      .catch(() => {});
  },
);
let filePreferenceVersion = 0;
async function configureFiles() {
  // Offscreen documents expose chrome.runtime, not chrome.storage. Settings
  // remain background-owned; ignore older replies when toggles race startup.
  const version = ++filePreferenceVersion;
  const saved = await bg('settings:get');
  if (version === filePreferenceVersion)
    files.setAutoSave(saved?.autoSaveFiles === true);
}
const filesReady = configureFiles();
void filesReady.then(() => files.flush()).catch((error) => files.failed(error));
const engine = new PlaybackEngine({
  cache,
  files,
  background: bg,
  createWorker: () => new DecodeWorker(),
  closeWorker: (worker) => closeDecodeWorker(worker, cleanupMediaTemps),
});
async function storageSummary() {
  const [cacheBytes, media, archives] = await Promise.all([
    cache.size(), mediaTempSummary(), files.summary(),
  ]);
  return { playback: { bytes: cacheBytes, limitBytes: CACHE_LIMIT }, media, archives };
}
chrome.runtime.onMessage.addListener((message: Envelope, sender, respond) => {
  if (
    message.target !== 'offscreen' ||
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(''))
  )
    return;
  void (async () => {
    await filesReady;
    if (message.type === 'files:configure') {
      await configureFiles();
      await files.flush();
      return true;
    }
    if (message.type === 'engine:start') {
      await engine.start(
        message.session as PlaybackSession,
        message.settings as Settings,
      );
      return true;
    }
    if (message.type === 'engine:language') {
      await engine.switchLanguage(
        message.session as PlaybackSession,
        Boolean(message.userPaused),
      );
      return true;
    }
    if (message.type === 'engine:mix') {
      const current = engine.session;
      if (current && current.id === message.sessionId &&
          (message.languageVersion === undefined || message.languageVersion === (current.languageVersion ?? 0)))
        Object.assign(current, {
          originalVolume: Number(message.originalVolume),
          dubVolume: Number(message.dubVolume),
          ...mergeCaptionPreferences(current, message),
        });
      return true;
    }
    if (message.type === 'engine:stop') {
      return engine.stop(typeof message.sessionId === 'string' ? message.sessionId : undefined);
    }
    if (message.type === 'engine:terminals') return engine.recordTerminals(message);
    if (message.type === 'storage:summary') return storageSummary();
    if (['cache:clear', 'media:clear', 'archives:clear'].includes(message.type)) {
      if (engine.session) throw new Error('请先停止翻译，再清理本机空间');
      await engine.settleDecoderCleanup();
      if (engine.session) throw new Error('请先停止翻译，再清理本机空间');
      if (message.type === 'cache:clear') await cache.clear();
      if (message.type === 'media:clear') await cleanupMediaTemps();
      if (message.type === 'archives:clear') await files.clear();
      return storageSummary();
    }
    if (message.type === 'files:status') return files.status();
    if (message.type === 'files:merge') {
      await files.finish(
        engine.session ? archiveContext(engine.session) : undefined,
        false,
      );
      return files.status();
    }
    if (message.type === 'files:retry') {
      await files.retry();
      return files.status();
    }
    if (message.type === 'engine:diagnostics') {
      const memory = (
        performance as unknown as {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory;
      return {
        ...engine.diagnostics,
        preparation: engine.preparation(),
        cacheBytes: await cache.size(),
        heap: memory
          ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize }
          : undefined,
      };
    }
    if (message.type === 'engine:probe') {
      const settings = message.settings as Settings;
      await translateWindow({
        url: endpoint(settings),
        mediaId: 'connection-test',
        language: settings.language,
        start: 0,
        samples: new Float32Array(4800),
        signal: new AbortController().signal,
        beforeConnect: async () => {
          await bg('auth:install');
        },
        afterClose: async () => {
          await bg('auth:remove');
        },
        onSegment: () => {},
        onProgress: () => {},
      });
      return '已连接 Qwen3.8 LiveTranslate';
    }
    if (message.type.startsWith('player:')) {
      await engine.clock(message);
      return true;
    }
    return false;
  })().then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: messageError(error) }),
  );
  return true;
});
