import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
await fs.mkdir('work', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('work/local-files-gate-'));
const extension = path.join(directory, 'extension');
const downloads = path.join(directory, 'downloads');
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
    'Actual built Chrome extension and disk downloads using an existing real translated WAV as a cache fixture; no new provider call',
  checks: [],
  files: [],
};
try {
  const root = await context.browser().newBrowserCDPSession();
  await root.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
  });
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
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
  await call('files:status');
  const wav = await fs.readFile('outputs/原音色译音示例.wav');
  const sourceHash = crypto.createHash('sha256').update(wav).digest('hex');
  const segment = {
    id: 'saved-voice',
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
  const candidate = {
    id: 'fixture',
    mediaId: segment.mediaId,
    tabId: 0,
    frameId: 0,
    site: 'bilibili',
    title: 'Local archive / 原音色',
    duration: 30,
    currentTime: 23,
    width: 640,
    height: 360,
    paused: true,
    ad: false,
    sourceStatus: 'ready',
  };
  const session = {
    id: 'fixture',
    epoch: 0,
    candidate,
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
  await panel.evaluate(async (segment) => {
    const request = indexedDB.open('qwen-video-dub', 2);
    request.onupgradeneeded = () => {
      const d = request.result;
      d.createObjectStore('windows', { keyPath: 'key' });
      d.createObjectStore('metadata', { keyPath: 'key' });
    };
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['windows', 'metadata'], 'readwrite');
    const row = {
      key: JSON.stringify([
        segment.mediaId + '|audio:default',
        'zh',
        segment.voice,
        23,
        30,
      ]),
      mediaId: segment.mediaId + '|audio:default',
      language: 'zh',
      voice: segment.voice,
      start: 23,
      end: 30,
      touched: Date.now(),
      bytes: segment.audio.length + 512,
    };
    tx.objectStore('windows').put({ ...row, segments: [segment] });
    tx.objectStore('metadata').put(row);
    await new Promise((r, j) => {
      tx.oncomplete = r;
      tx.onerror = () => j(tx.error);
    });
    db.close();
  }, segment);
  const start = () =>
    panel.evaluate(async (session) => {
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
      if (!r?.ok) throw new Error(r?.error ?? 'Engine did not respond');
    }, session);
  await start();
  const wait = async (check) => {
    for (let i = 0; i < 150; i++) {
      const status = await call('files:status');
      if (check(status)) return status;
      await panel.waitForTimeout(100);
    }
    throw new Error('Save queue did not settle');
  };
  let status = await wait((s) => s.saved === 1 && s.pending === 0 && !s.saving);
  await panel
    .getByRole('status')
    .filter({ hasText: '1 translation bundles saved' })
    .waitFor();
  const items = await panel.evaluate(() =>
    chrome.downloads.search({ state: 'complete' }),
  );
  assert.equal(items.length, 1);
  const filename = items[0].filename;
  execFileSync('unzip', ['-t', filename]);
  const transcript = JSON.parse(
    execFileSync('unzip', ['-p', filename, 'transcript.json']).toString(),
  );
  assert.equal(transcript.completeVideo, false);
  assert.equal(transcript.segments[0].sourceStart, 23);
  assert.equal(transcript.segments[0].sourceEnd, 25.504);
  const audio = execFileSync('unzip', [
    '-p',
    filename,
    transcript.segments[0].audioFile,
  ]);
  assert.equal(
    crypto.createHash('sha256').update(audio).digest('hex'),
    sourceHash,
  );
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.match(
    execFileSync('unzip', ['-p', filename, 'subtitles.srt']).toString(),
    /00:00:23,000 --> 00:00:25,504/,
  );
  report.files.push({
    relative: status.lastFilename,
    zipCrcPassed: true,
    wavIdentical: true,
    sampleRate: 24000,
    sourceStart: 23,
    sourceEnd: 25.504,
  });
  report.checks.push(
    'Cached real original-voice WAV exported automatically through the built engine; bilingual TXT/SRT/JSON and exact source timestamps verified on disk',
  );
  await start();
  await panel.waitForTimeout(500);
  assert.equal(
    (await panel.evaluate(() => chrome.downloads.search({}))).length,
    1,
  );
  report.checks.push(
    'Replaying identical cached translations does not create duplicate downloads',
  );
  await call('cache:clear');
  assert.equal((await fs.stat(filename)).isFile(), true);
  report.checks.push('Clearing playback cache leaves downloaded files intact');
  await panel.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'engine:stop' }),
  );
  // Persist an unfinished window, then recreate the offscreen document to verify
  // recovery of completed utterances that had not reached the window boundary.
  await root.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  await panel.evaluate(async (segment) => {
    const r = indexedDB.open('qwen-video-dub-files', 1);
    const db = await new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const context = {
      mediaId: 'recovered-fixture',
      title: 'Interrupted window',
      language: 'en',
      voice: segment.voice,
      trackId: 'default',
    };
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').put({
      key: JSON.stringify([
        context.mediaId,
        context.trackId,
        context.language,
        context.voice,
        23,
        30,
      ]),
      context,
      start: 23,
      end: 30,
      segments: [{ ...segment, mediaId: context.mediaId, language: 'en' }],
      ready: false,
      bytes: segment.audio.length + 512,
      revision: 1,
    });
    await new Promise((r, j) => {
      tx.oncomplete = r;
      tx.onerror = () => j(tx.error);
    });
    db.close();
    await chrome.offscreen.closeDocument();
  }, segment);
  status = await wait((s) => !!s.error && s.pending === 1 && !s.saving);
  await panel
    .getByRole('alert')
    .filter({ hasText: 'Saving failed.' })
    .waitFor();
  report.checks.push(
    'Unfinished-window utterances recovered after offscreen recreation; denied download remains queued and visibly reports failure',
  );
  await root.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
  });
  await panel
    .getByRole('button', { name: 'Retry saving', exact: true })
    .click();
  status = await wait((s) => s.pending === 0 && s.saved === 2 && !s.saving);
  assert.equal(status.error, undefined);
  report.checks.push(
    'User retry completes a previously interrupted disk download without losing queued audio',
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
