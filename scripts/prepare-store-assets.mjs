import { chromium } from 'playwright';
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = await fs.mkdtemp(path.resolve('work/store-assets-'));
await fs.cp('.output/chrome-mv3', path.join(directory, 'extension'), {
  recursive: true,
});
const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
const report = {
  at: new Date().toISOString(),
  scope:
    'Actual extension UI in a clean isolated profile, no credentials or model calls; composed store screenshots use no third-party video or simulated translation output.',
  screens: [],
};
try {
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: path.join(directory, 'extension'),
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 680 });
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.getByRole('heading', { name: 'Choose a video', exact: true }).waitFor();
  const logo = (await fs.readFile('public/brand/logo.svg')).toString('base64');
  const shots = [
    {
      name: 'screenshot-en-videos',
      title: ['The same voice.', 'A new language.'],
      sub: ['Speech translation in the original player.', 'Your language. The same timeline.'],
      tag: 'ORIGINAL-VOICE MODE · BILINGUAL SUBTITLES',
    },
    {
      name: 'screenshot-en-settings',
      title: ['Your account.', 'Your control.'],
      sub: [
        'Register and get your key at qianwenai.com.',
        'No project-hosted server or subscription.',
      ],
      tag: 'LOCAL CREDENTIALS · OPTIONAL LOCAL EXPORTS',
      settings: true,
    },
    {
      name: 'screenshot-zh-videos',
      title: ['Your language.', 'Your choice.'],
      sub: [
        'English and Simplified Chinese interface.',
        'Switch the spoken target while watching.',
      ],
      tag: '29 SPOKEN TARGET LANGUAGES · EN / 简体中文',
      chinese: true,
    },
  ];
  for (const s of shots) {
    if (s.settings) await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    if (s.chinese) {
      await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
      await page.locator('.locale-select').selectOption('zh');
      await page.getByRole('heading', { name: '选择要观看的视频', exact: true }).waitFor();
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw Error('Panel overflow');
    await page.evaluate(() => document.fonts.ready);
    const screenshot = (await page.screenshot()).toString('base64');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#f5f7f2"/><image href="data:image/svg+xml;base64,${logo}" x="76" y="68" width="72" height="72"/><g font-family="Arial,Helvetica,sans-serif" fill="#164a3f"><text x="168" y="113" font-size="24" font-weight="700">TimbraDub</text><text x="76" y="302" font-size="64" letter-spacing="-2" font-weight="700">${s.title[0]}</text><text x="76" y="378" font-size="64" letter-spacing="-2" font-weight="700">${s.title[1]}</text><text x="79" y="446" font-size="23" fill="#526b5d">${s.sub[0]}</text><text x="79" y="481" font-size="23" fill="#526b5d">${s.sub[1]}</text><text x="79" y="608" font-size="12" letter-spacing="1" fill="#627c69">${s.tag}</text><text x="79" y="710" font-size="14" fill="#627c69">Open-source preview · Register at qianwenai.com · Bring your own API key</text></g><rect x="775" y="48" width="410" height="704" rx="18" fill="#dce6dc"/><image href="data:image/png;base64,${screenshot}" x="780" y="60" width="400" height="680"/></svg>`;
    const out = `docs/store/assets/${s.name}.png`;
    await fs.writeFile(out, new Resvg(svg).render().asPng());
    report.screens.push({
      file: out,
      width: 1280,
      height: 800,
      credentials: 'absent',
      actualBuiltUI: true,
    });
  }
  report.passed = true;
} finally {
  await fs.writeFile('outputs/store-assets-verification.json', JSON.stringify(report, null, 2));
  await context.close();
  await fs.rm(directory, { recursive: true, force: true });
}
