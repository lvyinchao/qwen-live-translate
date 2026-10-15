import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
await fs.mkdir('work', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('work/local-files-gate-'));
const extension = path.join(directory, 'extension'),
  downloads = path.join(directory, 'downloads');
await fs.mkdir(downloads);
await fs.cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
const context = await chromium.launchPersistentContext(
  path.join(directory, 'profile'),
  {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  },
);
const report = {
  at: new Date().toISOString(),
  scope:
    'Real Chrome OPFS migration, quiet chunk staging and one merged download using an existing real translated WAV; no new model call',
  checks: [],
  files: [],
};
try {
  context.setDefaultTimeout(12000);
  const root = await context.browser().newBrowserCDPSession();
  await root.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/THIRD_PARTY_NOTICES.md`);
  const wav = await fs.readFile('outputs/原音色译音示例.wav');
  const segment = {
    id: 'voice1',
    mediaId: 'local-archive-fixture',
    language: 'zh',
    voice: 'original-auto-v1',
    start: 23,
    end: 25.504,
    sourceText: 'First of all, what is a large language model? really.',
    text: '首先，大语言模型到底是什么？',
    speaker: 0,
    audio: wav.toString('base64'),
    audioDuration: 3.84,
  };
  const second = { ...segment, id: 'voice2', start: 60, end: 62.504 };
  const archiveContext = {
    mediaId: segment.mediaId,
    title: 'Quiet merge / 原音色',
    language: 'zh',
    voice: segment.voice,
    trackId: 'default',
  };
  await setup.evaluate(
    async ({ context, segments }) => {
      const request = indexedDB.open('qwen-video-dub-files', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('pending', { keyPath: 'key' });
        request.result.createObjectStore('saved', { keyPath: 'key' });
      };
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('pending', 'readwrite');
      for (const s of segments)
        tx.objectStore('pending').put({
          key: JSON.stringify([
            context.mediaId,
            context.trackId,
            context.language,
            context.voice,
            s.start,
            s.end,
          ]),
          context,
          start: s.start,
          end: s.end,
          segments: [s],
          ready: true,
          bytes: s.audio.length + 512,
          revision: 1,
        });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { context: archiveContext, segments: [second, segment] },
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const call = (type, params = {}) =>
    panel.evaluate(
      async ({ type, params }) => {
        const r = await chrome.runtime.sendMessage({
          target: 'background',
          type,
          ...params,
        });
        if (!r.ok) throw new Error(r.error);
        return r.value;
      },
      { type, params },
    );
  let status = await call('files:status');
  assert.equal(status.staged, 2);
  assert.equal(status.pending, 1);
  assert.equal(status.error, undefined);
  assert.equal(status.saving, false);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    0,
  );
  const privateFiles = await panel.evaluate(async () => {
    const paths = [];
    async function walk(dir, prefix = '') {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory')
          await walk(handle, prefix + name + '/');
        else {
          const f = await handle.getFile();
          paths.push({ path: prefix + name, size: f.size });
        }
      }
    }
    await walk(await navigator.storage.getDirectory());
    return paths;
  });
  assert.equal(privateFiles.filter((f) => f.path.endsWith('.wav')).length, 2);
  report.checks.push(
    'Legacy 0.1.2 queued windows migrated to two actual OPFS WAV chunks; no download request or save prompt during staging, even with downloads denied',
  );
  await panel.evaluate(() => chrome.offscreen.closeDocument());
  status = await call('files:status');
  assert.equal(status.staged, 2);
  assert.equal(status.pending, 1);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    0,
  );
  report.checks.push(
    'Offscreen recreation restores quiet staged chunks without automatically retrying or starting downloads',
  );
  // Fill the existing playback cache so the real engine reaches translation end
  // without any model/network call, triggering its automatic final merge.
  await panel.evaluate(
    async (segments) => {
      const request = indexedDB.open('qwen-video-dub', 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('windows', { keyPath: 'key' });
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['windows', 'metadata'], 'readwrite'),
        s = segments[0];
      const row = {
        key: JSON.stringify([
          s.mediaId + '|audio:default',
          'zh',
          s.voice,
          23,
          90,
        ]),
        mediaId: s.mediaId + '|audio:default',
        language: 'zh',
        voice: s.voice,
        start: 23,
        end: 90,
        touched: Date.now(),
        bytes: segments.reduce((n, s) => n + s.audio.length + 512, 0),
      };
      tx.objectStore('windows').put({ ...row, segments });
      tx.objectStore('metadata').put(row);
      await new Promise((r, j) => {
        tx.oncomplete = r;
        tx.onerror = () => j(tx.error);
      });
      db.close();
    },
    [segment, second],
  );
  const session = {
    id: 'fixture',
    epoch: 0,
    candidate: {
      id: 'fixture',
      mediaId: segment.mediaId,
      tabId: 0,
      frameId: 0,
      site: 'bilibili',
      title: archiveContext.title,
      duration: 90,
      currentTime: 23,
      width: 640,
      height: 360,
      paused: true,
      ad: false,
      sourceStatus: 'ready',
    },
    language: 'zh',
    phase: 'preparing',
    position: 23,
    rate: 1,
    readyThrough: 23,
    inputThrough: 23,
    skipped: 0,
    originalVolume: 0,
    dubVolume: 1,
    subtitles: true,
    segments: [],
  };
  await root.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
  });
  await panel.evaluate(async (session) => {
    const r = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'engine:start',
      session,
      settings: {
        apiKey: '',
        workspace: '',
        region: 'cn-beijing',
        language: 'zh',
        uiLanguage: 'en',
      },
    });
    if (!r?.ok) throw new Error(r?.error ?? 'No response');
  }, session);
  const wait = async (check) => {
    for (let i = 0; i < 150; i++) {
      const s = await call('files:status');
      if (check(s)) return s;
      await panel.waitForTimeout(100);
    }
    throw new Error('Merge queue did not settle');
  };
  status = await wait((s) => s.saved === 1 && s.pending === 0 && !s.saving);
  const items = await panel.evaluate(() =>
    chrome.downloads.search({ state: 'complete' }),
  );
  assert.equal(items.length, 1);
  const filename = items[0].filename;
  execFileSync('unzip', ['-t', filename]);
  const merged = execFileSync('unzip', ['-p', filename, 'combined.wav']);
  assert.equal(merged.readUInt32LE(24), 24000);
  assert.equal(merged.length, 44 + (wav.length - 44) * 2);
  assert.deepEqual(
    merged.subarray(44),
    Buffer.concat([wav.subarray(44), wav.subarray(44)]),
  );
  const metadata = JSON.parse(
    execFileSync('unzip', ['-p', filename, 'transcript.json']).toString(),
  );
  assert.equal(metadata.segments[0].sourceStart, 23);
  assert.equal(metadata.segments[1].sourceStart, 60);
  assert.equal(metadata.segments[1].audioStart, 3.84);
  assert.equal(metadata.duration, 7.68);
  assert.match(
    execFileSync('unzip', ['-p', filename, 'combined.srt']).toString(),
    /00:00:03,840 --> 00:00:07,680/,
  );
  assert.match(
    execFileSync('unzip', ['-p', filename, 'source-subtitles.srt']).toString(),
    /00:01:00,000 --> 00:01:02,504/,
  );
  report.files.push({
    relative: status.lastFilename,
    zipCrcPassed: true,
    chunkCount: 2,
    downloadCount: 1,
    duration: 7.68,
    pcmBytesIdentical: true,
    separateAudioAndVideoTimelines: true,
  });
  report.checks.push(
    'Actual engine translation-end path creates exactly one merged ZIP; WAV PCM equals both original-voice clips in source order, with separate audio/video SRT and JSON timelines',
  );
  await panel.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'engine:stop' }),
  );
  await panel.waitForTimeout(250);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    1,
  );
  await call('cache:clear');
  assert.equal((await call('files:status')).staged, 2);
  assert.equal((await fs.stat(filename)).isFile(), true);
  report.checks.push(
    'Repeated stop does not download again; clearing playback cache retains both staged WAVs and the final disk file',
  );
  // A changed transcript revision forces a new final snapshot; rejecting its
  // final download must retain the silent chunks for an explicit retry.
  await panel.evaluate(async () => {
    const r = indexedDB.open('qwen-video-dub-files', 2);
    const db = await new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const jobs = await new Promise((resolve) => {
      const q = db.transaction('jobs').objectStore('jobs').getAll();
      q.onsuccess = () => resolve(q.result);
    });
    const tx = db.transaction('jobs', 'readwrite');
    for (const job of jobs)
      tx.objectStore('jobs').put({
        ...job,
        context: { ...job.context, title: job.context.title + ' updated' },
        revision: job.revision + 1,
      });
    await new Promise((r, j) => {
      tx.oncomplete = r;
      tx.onerror = () => j(tx.error);
    });
    db.close();
  });
  await root.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  await call('files:merge');
  status = await wait((s) => !!s.error && !s.saving);
  assert.equal(status.staged, 2);
  assert.equal(status.pending, 1);
  await panel.evaluate(() => chrome.offscreen.closeDocument());
  status = await call('files:status');
  const before = (await panel.evaluate(() => chrome.downloads.search({})))
    .length;
  await panel.waitForTimeout(300);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    before,
  );
  await root.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
  });
  await call('files:retry');
  status = await wait((s) => s.saved === 2 && s.pending === 0 && !s.saving);
  report.checks.push(
    'Interrupted final save retains original chunks; reopening stays quiet and explicit retry succeeds with one final snapshot',
  );
  // Only content-script settings are readable by a page; neither file metadata
  // nor direct offscreen save commands are available to untrusted contexts.
  await context.route('https://www.youtube.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<title>file security test</title><video width="640" height="360"></video>',
    }),
  );
  const web = await context.newPage();
  await web.goto('https://www.youtube.com/watch?v=local-files-test');
  const security = await panel.evaluate(async () => {
    const tab = (
      await chrome.tabs.query({
        url: 'https://www.youtube.com/watch?v=local-files-test',
      })
    )[0];
    return (
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: async () => {
          const denied = await chrome.runtime.sendMessage({
            target: 'background',
            type: 'files:status',
          });
          let bypass = false;
          try {
            const response = await chrome.runtime.sendMessage({
              target: 'offscreen',
              type: 'files:status',
            });
            bypass = !!response?.ok;
          } catch {}
          return { metadataDenied: !denied.ok, offscreenBypass: bypass };
        },
      })
    )[0].result;
  });
  assert.deepEqual(security, { metadataDenied: true, offscreenBypass: false });
  report.checks.push(
    'Webpage/content-script access to file metadata and direct offscreen commands rejected',
  );
  const invalid = await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'files:download',
      url: 'https://example.com',
      filename: '../escape.zip',
    }),
  );
  assert.equal(invalid.ok, false);
  report.checks.push(
    'Sidepanel cannot bypass the offscreen-only local download route',
  );
  await panel.setViewportSize({ width: 360, height: 950 });
  await panel.screenshot({
    path: 'outputs/local-files-en.png',
    fullPage: true,
  });
  await panel.locator('.locale-select').selectOption('zh');
  await panel
    .getByRole('button', { name: '查看已保存文件', exact: true })
    .waitFor();
  await panel.screenshot({
    path: 'outputs/local-files-zh.png',
    fullPage: true,
  });
  const evidence = path.resolve('outputs/local-save-example.zip');
  await fs.copyFile(filename, evidence);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  await fs.writeFile(
    'outputs/local-files-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
}
