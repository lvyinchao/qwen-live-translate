import { isolatedTestEnv } from './test-environment.mjs';
import { syntheticWav } from '../tests/fixtures/audio.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

await fs.mkdir('work', { recursive: true });
await fs.mkdir('outputs', { recursive: true });
const extension = await fs.mkdtemp(path.resolve('work/extension-snapshot-'));
const profile = await fs.mkdtemp(path.resolve('work/ui-browser-'));
await fs.cp(
  path.resolve(process.env.EXTENSION_DIR ?? '.output/chrome-mv3'),
  extension,
  { recursive: true },
);
const context = await chromium.launchPersistentContext(profile, {
  env: isolatedTestEnv(),
  channel: 'chromium',
  headless: !!process.env.HEADLESS,
  locale: 'zh-CN', // A Chinese browser must still start with the English UI.
  timeout: 25000,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
const result = {
  at: new Date().toISOString(),
  scope: 'Isolated UI fixtures only; no model call or real-video acceptance',
  errors: [],
  checks: [],
  screens: [],
};
try {
  // Fixture routes below override this default deny rule. Never contact real sites/models.
  await context.route(/^https?:/, (route) => route.abort('blockedbyclient'));
  await context.routeWebSocket(/^wss?:/, (socket) =>
    socket.close({
      code: 1000,
      reason: 'Offline test: no external WebSockets',
    }),
  );
  context.setDefaultTimeout(10000);
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const panel = await context.newPage();
  panel.on('pageerror', (error) => result.errors.push(error.message));
  const url = `chrome-extension://${id}/sidepanel.html`;
  const call = (type, parameters = {}) =>
    panel.evaluate(
      async ({ type, parameters }) => {
        const response = await chrome.runtime.sendMessage({
          target: 'background',
          type,
          ...parameters,
        });
        if (!response.ok) throw new Error(response.error);
        return response.value;
      },
      { type, parameters },
    );
  const waitLocale = async (locale, page = panel) => {
    await page.waitForFunction(
      (locale) =>
        document.documentElement.lang === (locale === 'zh' ? 'zh-CN' : 'en'),
      locale,
    );
    await page.locator('.locale-select:enabled').waitFor();
    assert.equal(await page.locator('.locale-select').inputValue(), locale);
    assert.equal(await call('ui:get'), locale);
    const productTitle = locale === 'zh'
      ? '听译 · 原音色视频翻译'
      : 'TimbraDub · Original-Voice Video Translation';
    await page.waitForFunction((title) => document.title === title, productTitle);
    assert.equal(await page.locator('.header').getAttribute('aria-label'), productTitle);
    assert.equal(await page.locator('.brand strong').innerText(), locale === 'zh' ? '听译' : 'TimbraDub');
    assert.equal(await page.locator('.brand span').last().innerText(), locale === 'zh' ? '原声音色' : 'ORIGINAL VOICE');
    await page.waitForFunction(async (title) => (await chrome.action.getTitle({})) === title,
      locale === 'zh' ? '打开听译 · 原音色视频翻译' : 'Open TimbraDub · Original-Voice Video Translation');
  };
  const screenshot = async (locale, view) => {
    for (const width of [360, 480]) {
      await panel.setViewportSize({ width, height: 850 });
      assert.equal(
        await panel.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${locale}/${view} overflow at ${width}px`,
      );
      const file = `outputs/ui-${locale}-${view}-${width}.png`;
      await panel.screenshot({ path: file, fullPage: true });
      result.screens.push({ locale, view, width, overflow: false, file });
    }
  };
  await panel.goto(url);
  await waitLocale('en');
  await panel
    .getByRole('heading', { name: 'Choose a video', exact: true })
    .waitFor();
  assert.equal(await panel.locator('#language').inputValue(), 'zh');
  assert.equal(
    await panel.locator('#language option[value="zh"]').textContent(),
    'Chinese',
  );
  result.checks.push(
    'English default even in a zh-CN browser; target language remains Chinese',
  );
  assert.equal(await panel.locator('#language option').count(), 29);
  assert.equal(
    await panel.locator('.provider-notice a').getAttribute('href'),
    'https://qianwenai.com/',
  );
  assert.match(
    await panel.locator('.provider-notice').innerText(),
    /register an account and obtain an API key/,
  );
  result.checks.push(
    'All 29 targets and a visible self-registration/API-key link on the English first-run page',
  );
  await screenshot('en', 'videos');
  await panel.locator('.locale-select').selectOption('zh');
  await waitLocale('zh');
  await panel
    .getByRole('heading', { name: '选择要观看的视频', exact: true })
    .waitFor();
  await screenshot('zh', 'videos');
  await panel.reload();
  await waitLocale('zh');
  result.checks.push('Chinese preference survives panel reload');
  await panel.getByRole('button', { name: '打开设置', exact: true }).click();
  assert.match(
    await panel.locator('.provider-notice').innerText(),
    /注册账号并申请 API Key/,
  );
  assert.equal(
    await panel.locator('.provider-notice a').getAttribute('href'),
    'https://qianwenai.com/',
  );
  result.checks.push(
    'Chinese settings explicitly require the user’s own account and API key',
  );
  await panel.getByLabel('Workspace ID').fill('invalid workspace');
  await panel.getByLabel('API Key').fill('test-not-a-real-key');
  await panel.getByRole('button', { name: '保存配置', exact: true }).click();
  await panel
    .getByRole('alert')
    .filter({ hasText: '请填写有效的百炼 Workspace ID' })
    .waitFor();
  await panel.locator('.locale-select').selectOption('en');
  await waitLocale('en');
  // Switching locale preserves unsaved credential fields.
  const saveSwitch = panel.getByRole('switch', {
    name: 'Save translation files automatically',
    exact: true,
  });
  await saveSwitch.check();
  await panel.locator('input[role="switch"]:enabled').waitFor();
  await saveSwitch.uncheck();
  await panel.locator('input[role="switch"]:enabled').waitFor();
  assert.equal(
    await panel.getByLabel('Workspace ID').inputValue(),
    'invalid workspace',
  );
  assert.equal((await call('settings:get')).hasKey, false);
  result.checks.push(
    'Save toggle preserves unsaved credential fields and does not submit them',
  );
  assert.equal(
    await panel.getByLabel('API Key').inputValue(),
    'test-not-a-real-key',
  );
  await panel
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  await panel
    .getByRole('alert')
    .filter({ hasText: 'Enter a valid Model Studio workspace ID.' })
    .waitFor();
  await panel.getByLabel('Workspace ID').fill('ui-test');
  await panel
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  await panel
    .getByRole('status')
    .filter({ hasText: 'Settings saved in this browser.' })
    .waitFor();
  assert.equal(await panel.getByLabel('API Key').inputValue(), '');
  await screenshot('en', 'settings');
  await panel.locator('.locale-select').selectOption('zh');
  await waitLocale('zh');
  await screenshot('zh', 'settings');
  result.checks.push(
    'English and Chinese validation, settings labels and notices; key input cleared after saving',
  );

  const second = await context.newPage();
  await second.goto(url);
  await waitLocale('zh', second);
  await second.locator('.locale-select').selectOption('en');
  await waitLocale('en', second);
  await waitLocale('en');
  const settings = await call('settings:get');
  assert.equal(settings.hasKey, true);
  assert.equal(settings.language, 'zh');
  assert.equal(settings.workspace, 'ui-test');
  assert.equal(Object.hasOwn(settings, 'apiKey'), false);
  result.checks.push(
    'Language preference propagates between panels without changing credentials or target language',
  );

  // Render every session phase, counts, speed and a translated error. These are
  // controlled UI fixtures, not simulated translation acceptance.
  const candidate = {
    id: 'ui-fixture',
    mediaId: 'youtube:qvd-ui-test:',
    tabId: 0,
    frameId: 0,
    site: 'youtube',
    title: 'UI fixture',
    poster: '',
    duration: 180,
    currentTime: 0,
    width: 640,
    height: 360,
    paused: true,
    ad: false,
    sourceStatus: 'discovering',
  };
  const session = {
    id: 'ui-fixture',
    epoch: 1,
    candidate,
    language: 'zh',
    phase: 'buffering',
    position: 0,
    rate: 1.5,
    readyThrough: 30,
    inputThrough: 30,
    skipped: 2,
    originalVolume: 0,
    dubVolume: 1,
    subtitles: true,
    segments: [
      {
        id: 's',
        start: 0,
        end: 5,
        sourceText: 'Original content',
        text: '翻译内容',
        skipped: true,
      },
    ],
  };
  const publish = async (value) =>
    second.evaluate(
      (session) =>
        chrome.runtime.sendMessage({ type: 'session:updated', session }),
      value,
    );
  await panel
    .getByRole('button', { name: 'Back to videos', exact: true })
    .click();
  for (const [phase, label] of Object.entries({
    idle: 'Not started',
    preparing: 'Preparing',
    buffering: 'Buffering',
    playing: 'Translating',
    paused: 'Paused',
    ended: 'Ended',
    error: 'Needs attention',
  })) {
    await publish({ ...session, phase });
    await panel
      .locator('.session-line strong')
      .filter({ hasText: label })
      .waitFor();
  }
  await publish({
    ...session,
    error: '翻译连接提前断开（1006），本段未标记为完成',
  });
  await panel
    .getByRole('alert')
    .filter({ hasText: 'Translation disconnected early (1006).' })
    .waitFor();
  await panel.getByLabel('Bilingual subtitles', { exact: true }).waitFor();
  assert.match(
    await panel.locator('.buffer-label').innerText(),
    /30s of audio ready ahead/,
  );
  assert.match(
    await panel.locator('.buffer-label').innerText(),
    /1.5× playback/,
  );
  assert.equal(await panel.getByText('翻译内容', { exact: false }).count(), 1);
  await screenshot('en', 'session');
  await panel.locator('.locale-select').selectOption('zh');
  await waitLocale('zh');
  await panel.getByLabel('双语字幕', { exact: true }).waitFor();
  await panel
    .getByRole('alert')
    .filter({ hasText: '翻译连接提前断开（1006）' })
    .waitFor();
  await screenshot('zh', 'session');
  await publish(null);
  result.checks.push(
    'All session phases, buffer progress, speed, skips, errors and subtitle control localized; transcript unchanged',
  );

  // A local YouTube-shaped page loads the actual built content script, with
  // network requests fulfilled locally and no remote video or credentials.
  await context.route('https://www.youtube.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>UI fixture</title><div id="movie_player"><video class="html5-main-video" data-qvd-id="ui-fixture" width="640" height="360"></video></div>',
    }),
  );
  const video = await context.newPage();
  await video.goto('https://www.youtube.com/watch?v=qvd-ui-test');
  const tabId = await panel.evaluate(
    async () =>
      (
        await chrome.tabs.query({
          url: 'https://www.youtube.com/watch?v=qvd-ui-test',
        })
      )[0].id,
  );
  await panel.evaluate(
    async ({ tabId, session }) => {
      const response = await chrome.tabs.sendMessage(
        tabId,
        {
          type: 'player:attach',
          session: { ...session, candidate: { ...session.candidate, tabId } },
        },
        { frameId: 0 },
      );
      if (!response.ok) throw new Error('Fixture player failed to attach');
    },
    { tabId, session },
  );
  const cdp = await context.newCDPSession(video);
  await cdp.send('DOM.enable');
  const captionNode = async () => {
    const { root } = await cdp.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    });
    let found;
    function visit(node) {
      if (
        (node.attributes ?? []).some(
          (attribute, i, list) =>
            attribute === 'class' && list[i + 1] === 'caption',
        )
      )
        found = node;
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
      ])
        visit(child);
    }
    visit(root);
    function text(node) {
      return (node.nodeValue ?? '') + (node.children ?? []).map(text).join('');
    }
    return { found, text: found ? text(found) : '' };
  };
  const caption = async () => (await captionNode()).text;
  const captionDisplay = async () => {
    const { found } = await captionNode();
    assert.ok(found, 'caption exists in the closed shadow root');
    const { object } = await cdp.send('DOM.resolveNode', {
      backendNodeId: found.backendNodeId,
    });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function(){ return { hidden: this.hidden, display: getComputedStyle(this).display, height: this.getBoundingClientRect().height }; }',
      returnByValue: true,
    });
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
    return result.value;
  };
  await video.waitForTimeout(350);
  assert.match(await caption(), /正在准备译音/);
  await panel.locator('.locale-select').selectOption('en');
  await waitLocale('en');
  assert.match(await caption(), /Preparing audio · 30s ready/);
  await video.reload();
  await panel.evaluate(
    async ({ tabId, session }) =>
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'player:attach',
          session: { ...session, candidate: { ...session.candidate, tabId } },
        },
        { frameId: 0 },
      ),
    { tabId, session },
  );
  await video.waitForTimeout(350);
  assert.match(await caption(), /Preparing audio/);
  const playerMessage = (message) =>
    panel.evaluate(
      ({ tabId, message }) =>
        chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      { tabId, message },
    );
  const wav = syntheticWav().toString('base64');
  const playing = {
    ...session,
    candidate: { ...session.candidate, tabId },
    phase: 'paused',
    subtitles: true,
  };
  await playerMessage({ type: 'player:state', session: playing });
  await playerMessage({
    type: 'player:segment',
    epoch: session.epoch,
    segment: {
      ...session.segments[0],
      mediaId: candidate.mediaId,
      language: 'zh',
      voice: 'original-auto-v1',
      audio: wav,
      audioDuration: 3.84,
    },
  });
  assert.equal((await captionDisplay()).display, 'flex');
  assert.match(await caption(), /翻译内容/);
  await playerMessage({
    type: 'player:mix',
    originalVolume: 0,
    dubVolume: 1,
    subtitles: false,
  });
  assert.deepEqual(await captionDisplay(), {
    hidden: true,
    display: 'none',
    height: 0,
  });
  await playerMessage({
    type: 'player:segment',
    epoch: session.epoch,
    segment: {
      ...session.segments[0],
      id: 'replacement',
      mediaId: candidate.mediaId,
      language: 'zh',
      voice: 'original-auto-v1',
      sourceText: 'New source',
      text: '新到达的译文',
      audio: wav,
      audioDuration: 3.84,
    },
  });
  await playerMessage({
    type: 'player:state',
    session: { ...playing, subtitles: false },
  });
  await video.waitForTimeout(400);
  assert.deepEqual(await captionDisplay(), {
    hidden: true,
    display: 'none',
    height: 0,
  });
  await video
    .locator('video')
    .evaluate((v) => v.parentElement.requestFullscreen());
  assert.equal(await video.evaluate(() => !!document.fullscreenElement), true);
  assert.equal((await captionDisplay()).display, 'none');
  await playerMessage({
    type: 'player:mix',
    originalVolume: 0,
    dubVolume: 1,
    subtitles: true,
  });
  assert.equal((await captionDisplay()).display, 'flex');
  assert.match(await caption(), /新到达的译文/);
  await video.evaluate(() => document.exitFullscreen());
  await playerMessage({
    type: 'player:mix',
    originalVolume: 0,
    dubVolume: 1,
    subtitles: false,
  });
  await playerMessage({
    type: 'player:attach',
    session: { ...playing, subtitles: false },
  });
  await video.waitForTimeout(300);
  assert.equal((await captionDisplay()).display, 'none');
  result.checks.push(
    'Caption toggle hides rendered pixels immediately; remains hidden after segment/state updates, fullscreen and reattachment; re-enabling restores text',
  );
  const isolated = await panel.evaluate(
    async (tabId) =>
      (
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          func: async () => {
            const locale = await chrome.runtime.sendMessage({
              target: 'background',
              type: 'ui:get',
            });
            const settings = await chrome.runtime.sendMessage({
              target: 'background',
              type: 'settings:get',
            });
            const mutation = await chrome.runtime.sendMessage({
              target: 'background',
              type: 'ui:set',
              language: 'zh',
            });
            let storageBlocked = false;
            try {
              await chrome.storage.local.get('settings');
            } catch {
              storageBlocked = true;
            }
            return {
              locale: locale.value,
              settingsDenied: !settings.ok,
              mutationDenied: !mutation.ok,
              storageBlocked,
            };
          },
        })
      )[0].result,
    tabId,
  );
  assert.deepEqual(isolated, {
    locale: 'en',
    settingsDenied: true,
    mutationDenied: true,
    storageBlocked: true,
  });
  await panel.evaluate(
    (tabId) => chrome.tabs.sendMessage(tabId, { type: 'player:stop' }),
    tabId,
  );
  result.checks.push(
    'Built player overlay updates live and restores locale after navigation; content script can read only locale and cannot change it or access credentials',
  );

  // Older installations have no uiLanguage. They must migrate to English while
  // retaining their saved target language and credentials.
  await panel.evaluate(async () =>
    chrome.storage.local.set({
      settings: {
        apiKey: 'test-not-a-real-key',
        workspace: 'legacy-test',
        region: 'cn-beijing',
        language: 'ja',
      },
    }),
  );
  await panel.reload();
  await waitLocale('en');
  assert.equal(await panel.locator('#language').inputValue(), 'ja');
  assert.equal((await call('settings:get')).hasKey, true);
  await panel.locator('.locale-select').selectOption('zh');
  await waitLocale('zh');
  await panel.getByRole('button', { name: '打开设置', exact: true }).click();
  await panel.getByRole('button', { name: '移除凭据', exact: true }).click();
  await panel
    .getByRole('status')
    .filter({ hasText: '本机凭据已移除' })
    .waitFor();
  assert.equal((await call('settings:get')).hasKey, false);
  assert.equal((await call('settings:get')).language, 'ja');
  await panel.reload();
  await waitLocale('zh');
  result.checks.push(
    'Legacy settings default to English without losing existing values; removing credentials preserves UI and target languages',
  );
  const invalid = await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'ui:set',
      language: 'fr',
    }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(await call('ui:get'), 'zh');
  const title = await panel.evaluate(() => chrome.action.getTitle({}));
  assert.equal(title, '打开听译 · 原音色视频翻译');
  result.checks.push(
    'Unsupported UI locale rejected; panel brand/title, original-voice label and toolbar title follow the saved preference across switches and reloads',
  );
  assert.deepEqual(result.errors, []);
  result.passed = true;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  throw error;
} finally {
  await fs.writeFile(
    'outputs/ui-verification.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(extension, { recursive: true, force: true });
}
