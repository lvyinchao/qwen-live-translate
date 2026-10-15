import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const extension = await fs.mkdtemp(path.resolve('work/extension-snapshot-'));
await fs.cp(
  path.resolve(process.env.EXTENSION_DIR ?? '.output/chrome-mv3'),
  extension,
  { recursive: true },
);
const c = await chromium.launchPersistentContext(
  await fs.mkdtemp(path.resolve('work/ui-browser-')),
  {
    channel: 'chromium',
    headless: !!process.env.HEADLESS,
    timeout: 25000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  },
);
const result = { errors: [], screens: [] };
try {
  const root = await c.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: extension,
  });
  const p = await c.newPage();
  p.on('pageerror', (e) => result.errors.push(e.message));
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForTimeout(800);
  for (const width of [360, 480]) {
    await p.setViewportSize({ width, height: 800 });
    await p.screenshot({ path: `outputs/侧边栏-${width}.png`, fullPage: true });
    result.screens.push({
      width,
      overflow: await p.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    });
  }
  await p.getByRole('button', { name: '打开设置' }).click();
  await p.getByLabel('Workspace ID').fill('llm-preview');
  await p.getByLabel('API Key').fill('test-not-a-real-key');
  await p.getByRole('button', { name: '保存配置', exact: true }).click();
  await p.getByRole('status').waitFor();
  result.masked = (await p.getByLabel('API Key').inputValue()) === '';
  const tab = await c.newPage();
  await tab.goto('https://example.com');
  result.webPageSecretRead = await tab.evaluate(() =>
    typeof chrome.runtime === 'undefined'
      ? 'not available'
      : 'unexpected runtime',
  );
  result.contentScriptStorage = await p.evaluate(async () => {
    const tab = (await chrome.tabs.query({ url: 'https://example.com/*' }))[0];
    return (
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: async () => {
          try {
            const settings = await chrome.storage.local.get('settings');
            return { blocked: false, keyReadable: !!settings.settings?.apiKey };
          } catch {
            return { blocked: true, keyReadable: false };
          }
        },
      })
    )[0].result;
  });
  if (result.contentScriptStorage.keyReadable)
    throw new Error('Content scripts can read the local key');
  await p.bringToFront();
  await p.screenshot({ path: 'outputs/设置界面.png', fullPage: true });
  await fs.writeFile(
    'work/ui-verification.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await c.close();
}
