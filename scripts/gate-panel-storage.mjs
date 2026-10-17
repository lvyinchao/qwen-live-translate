import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isolatedTestEnv } from './test-environment.mjs';
await fs.mkdir('work', { recursive: true });
await fs.mkdir('outputs', { recursive: true });
const extension = await fs.mkdtemp(path.resolve('work/panel-storage-extension-'));
const profile = await fs.mkdtemp(path.resolve('work/panel-storage-browser-'));
await fs.cp(path.resolve(process.env.EXTENSION_DIR ?? '.output/chrome-mv3'), extension, {
  recursive: true,
});
const context = await chromium.launchPersistentContext(profile, {
  env: isolatedTestEnv(),
  channel: 'chromium',
  headless: !!process.env.HEADLESS,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
const result = {
  at: new Date().toISOString(),
  scope: 'Isolated browser-private storage fixtures; no account, model or user download data',
  checks: [],
  errors: [],
};
try {
  context.setDefaultTimeout(10000);
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: extension });
  const panel = await context.newPage();
  panel.on('pageerror', (error) => result.errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.getByRole('button', { name: 'Open settings', exact: true }).click();
  await panel.getByRole('button', { name: 'Clear audio cache', exact: true }).waitFor();
  const call = (type) =>
    panel.evaluate(async (type) => {
      const response = await chrome.runtime.sendMessage({ target: 'background', type });
      if (!response.ok) throw new Error(response.error);
      return response.value;
    }, type);
  await call('storage:summary');
  await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('qwen-video-dub', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = {
      key: 'storage-fixture',
      mediaId: 'fixture',
      language: 'zh',
      voice: 'original-auto-v1',
      start: 0,
      end: 5,
      touched: Date.now(),
      bytes: 2048,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['windows', 'metadata'], 'readwrite');
      tx.objectStore('windows').put({ ...record, segments: [] });
      tx.objectStore('metadata').put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const disk = await navigator.storage.getDirectory();
    for (const [directory, filename, size] of [
      ['qwen-video-dub-media-tmp', 'fixture-source', 4096],
      ['qwen-video-dub', 'fixture-orphan.wav', 8192],
    ]) {
      const folder = await disk.getDirectoryHandle(directory, { create: true });
      const file = await folder.getFileHandle(filename, { create: true });
      const sink = await file.createWritable();
      await sink.write(new Uint8Array(size));
      await sink.close();
    }
  });
  const before = await call('storage:summary');
  assert.equal(before.playback.bytes, 2048);
  assert.equal(before.media.bytes, 4096);
  assert.equal(before.archives.bytes, 8192);
  await panel.getByRole('button', { name: 'Refresh storage usage', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Refresh storage usage', exact: true })
    .waitFor({ state: 'visible' });
  await panel.waitForFunction(() =>
    document.querySelector('.storage-view')?.textContent.includes('8.0 KiB'),
  );
  assert.equal(await panel.locator('.storage-row').count(), 3);
  result.checks.push(
    'Three independent categories report seeded playback cache, source media and archive bytes',
  );
  for (const [label, category] of [
    ['Clear audio cache', 'playback'],
    ['Clear temporary source media', 'media'],
    ['Clear staged audio and transcripts', 'archives'],
  ]) {
    await panel.getByRole('button', { name: label, exact: true }).click();
    await panel.waitForFunction(() => !document.querySelector('.storage-row button')?.disabled);
    assert.equal((await call('storage:summary'))[category].bytes, 0);
  }
  result.checks.push(
    'Each visible clear action removes its own browser-private bytes and returns refreshed totals',
  );
  assert.equal((await call('settings:get')).autoSaveFiles, false);
  await panel.locator('.locale-select').selectOption('zh');
  await panel.getByRole('heading', { name: '本机存储空间', exact: true }).waitFor();
  assert.match(await panel.locator('.storage-view').innerText(), /已下载|下载目录/);
  for (const width of [360, 480]) {
    await panel.setViewportSize({ width, height: 900 });
    assert.equal(
      await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  result.checks.push(
    'Automatic saving remains off; Chinese storage copy explains downloaded files; 360/480 px do not overflow',
  );
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${id}/sidepanel.html`);
  const preparationSession = {
    id: 'preparation-fixture',
    epoch: 1,
    languageVersion: 0,
    stateVersion: 10,
    language: 'zh',
    phase: 'buffering',
    candidate: { duration: 300 },
    position: 20,
    rate: 1.5,
    readyThrough: 40,
    inputThrough: 45,
    skipped: 0,
    originalVolume: 0,
    dubVolume: 1,
    subtitles: true,
    segments: [],
    preparation: {
      videoRate: 1.5,
      startupTargetSeconds: 45,
      maintainTargetSeconds: 90,
      maxAheadSeconds: 90,
      inputRealtimeFactor: 0.95,
      preparedRealtimeFactor: 0.8,
      netBufferSecondsPerSecond: -0.7,
      limitedByRealtimeInput: true,
    },
  };
  const updateSession = (session) =>
    helper.evaluate(
      async (session) => chrome.runtime.sendMessage({ type: 'session:updated', session }),
      session,
    );
  await updateSession(preparationSession);
  await panel.waitForFunction(() =>
    [...document.querySelectorAll('.storage-row button')].every((button) => button.disabled),
  );
  assert.equal(await panel.getByLabel('API Key').isDisabled(), true);
  assert.equal(await panel.getByLabel('Workspace ID', { exact: true }).isDisabled(), true);
  assert.equal(await panel.locator('#region').isDisabled(), true);
  await panel.getByRole('button', { name: '返回视频', exact: true }).click();
  await panel.getByLabel('译音准备状态', { exact: true }).waitFor();
  assert.match(await panel.locator('.preparation-card').innerText(), /45.*90/);
  assert.match(await panel.locator('.preparation-card').innerText(), /0.80.*1.5/);
  for (const width of [360, 480]) {
    await panel.setViewportSize({ width, height: 900 });
    assert.equal(
      await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  result.checks.push(
    'Active tasks disable all destructive storage actions; rate-adjusted buffer targets and measured preparation limits are visible',
  );
  await updateSession({
    ...preparationSession,
    stateVersion: 9,
    phase: 'error',
    error: 'stale retry fixture',
  });
  assert.equal(await panel.getByLabel('译音准备状态', { exact: true }).count(), 1);
  assert.equal(await panel.getByText('stale retry fixture', { exact: false }).count(), 0);
  await updateSession({
    ...preparationSession,
    stateVersion: 11,
    phase: 'error',
    error: 'current failure fixture',
  });
  await panel.getByText('current failure fixture', { exact: false }).waitFor();
  await updateSession({ ...preparationSession, stateVersion: 10, phase: 'playing' });
  assert.equal(await panel.getByText('current failure fixture', { exact: false }).count(), 1);
  result.checks.push(
    'The sidepanel ignores older same-epoch retries and retains a newer terminal error',
  );
  assert.deepEqual(result.errors, []);
} finally {
  await context.close();
  await fs.rm(extension, { recursive: true, force: true });
  await fs.rm(profile, { recursive: true, force: true });
  await fs.writeFile(
    'outputs/panel-storage-verification.json',
    JSON.stringify(result, null, 2) + '\n',
  );
}
console.log(JSON.stringify(result));
