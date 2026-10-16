import { isolatedTestEnv } from './test-environment.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';

const root = process.cwd();
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const prefix = `timbradub-${version}`;
await fs.mkdir('work', { recursive: true });
await fs.mkdir('outputs', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('work/release-smoke-'));
const downloads = path.join(directory, 'downloads');
await fs.mkdir(downloads);
const userConfig = path.join(directory, 'empty-user.npmrc');
const globalConfig = path.join(directory, 'empty-global.npmrc');
await fs.writeFile(userConfig, '');
await fs.writeFile(globalConfig, '');
const commandEnv = isolatedTestEnv({
  HEADLESS: '1',
  NPM_CONFIG_USERCONFIG: userConfig,
  NPM_CONFIG_GLOBALCONFIG: globalConfig,
});
const names = [
  `${prefix}-chrome.zip`,
  `${prefix}-source.zip`,
  'SHA256SUMS.txt',
];
const server = http.createServer((request, response) => {
  const name = decodeURIComponent(
    new URL(request.url, 'http://localhost').pathname.slice(1),
  );
  if (name === '') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    const base = process.env.RELEASE_BASE_URL?.replace(/\/$/, '') ?? '';
    response.end(
      `<title>Release installation test</title>${names.map((file) => `<p><a href="${base}/${file}" download="${file}">${file}</a></p>`).join('')}`,
    );
    return;
  }
  if (!names.includes(name)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': name.endsWith('.zip')
      ? 'application/zip'
      : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  createReadStream(path.join(root, 'outputs', name))
    .on('error', () => response.destroy())
    .pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  at: new Date().toISOString(),
  version,
  scope:
    'Actual ZIP downloads, root-folder installation and clean source-archive checks; synthetic fixtures only, no provider calls',
  source: process.env.RELEASE_BASE_URL
    ? 'public-release'
    : 'local-http-download',
  checks: [],
  downloads: [],
  commands: [],
};
let context;

async function command(args, cwd) {
  const started = Date.now();
  console.log(`Source archive: npm ${args.join(' ')}`);
  const log = path.join(directory, `source-${report.commands.length}.log`);
  const output = createWriteStream(log);
  const result = await new Promise((resolve, reject) => {
    const npm = process.env.npm_execpath;
    const child = spawn(
      npm ? process.execPath : 'npm',
      npm ? [npm, ...args] : args,
      {
        cwd,
        env: commandEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const timer = setTimeout(
      () => {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {}
        }
      },
      12 * 60 * 1000,
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => output.write(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  await new Promise((resolve) => output.end(resolve));
  report.commands.push({
    command: `npm ${args.join(' ')}`,
    exitCode: result.code,
    elapsedMs: Date.now() - started,
  });
  if (result.code !== 0) {
    // These subprocesses use isolatedTestEnv and fixture-only tests. Surface a
    // bounded diagnostic tail in CI, without adding raw logs to release receipts.
    const diagnostic = (await fs.readFile(log, 'utf8'))
      .slice(-20000)
      .replaceAll(directory, '<isolated release workspace>')
      .replaceAll(root, '<project>');
    console.error(`Source archive failure diagnostic:\n${diagnostic}`);
    // Logs stay under ignored work/. Do not copy raw command output into published reports.
    throw new Error(
      `Source archive npm ${args.join(' ')} failed (${result.code ?? result.signal}); see ignored work/release-smoke-* logs`,
    );
  }
}

function extract(file, destination) {
  execFileSync('unzip', ['-tqq', file]);
  const entries = unzipSync(readFileSync(file));
  const root = path.resolve(destination);
  for (const [entry, bytes] of Object.entries(entries)) {
    const target = path.resolve(root, entry);
    assert.ok(
      !entry.startsWith('/') &&
        !entry.includes('\\') &&
        !entry.split('/').includes('..') &&
        (target === root || target.startsWith(root + path.sep)),
      'Unsafe ZIP path',
    );
    // Use UTF-8-aware extraction instead of platform unzip's locale-dependent names.
    if (entry.endsWith('/')) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }
}

try {
  context = await chromium.launchPersistentContext(
    path.join(directory, 'profile'),
    {
      env: isolatedTestEnv(),
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    },
  );
  await context.route(/^https?:/, (route) => {
    const url = new URL(route.request().url());
    const remote =
      process.env.RELEASE_BASE_URL &&
      (url.origin === new URL(process.env.RELEASE_BASE_URL).origin ||
        url.hostname.endsWith('.githubusercontent.com'));
    return url.origin === origin || remote
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/^wss?:/, (socket) =>
    socket.close({ code: 1000, reason: 'Release test: no provider calls' }),
  );
  const page = await context.newPage();
  await page.goto(origin);
  for (const name of names) {
    const pending = page.waitForEvent('download');
    await page.getByRole('link', { name, exact: true }).click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    await download.saveAs(path.join(downloads, name));
  }
  const expected = new Map(
    (await fs.readFile(path.join(downloads, 'SHA256SUMS.txt'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/);
        assert.ok(match);
        return [match[2], match[1]];
      }),
  );
  for (const name of names.filter((name) => name.endsWith('.zip'))) {
    const sha256 = crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(downloads, name)))
      .digest('hex');
    assert.equal(sha256, expected.get(name));
    report.downloads.push({ name, sha256 });
  }
  report.checks.push(
    'Chrome actually downloaded the Chrome ZIP, source ZIP and checksums; both downloaded archives match SHA-256',
  );
  const installation = path.join(directory, 'installation');
  extract(path.join(downloads, `${prefix}-chrome.zip`), installation);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(installation, 'manifest.json'), 'utf8'),
    ).version,
    version,
  );
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', {
    path: installation,
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel
    .getByRole('heading', { name: 'Choose a video', exact: true })
    .waitFor();
  const installed = await panel.evaluate(async () => ({
    manifest: chrome.runtime.getManifest(),
    settings: await chrome.runtime.sendMessage({
      target: 'background',
      type: 'settings:get',
    }),
  }));
  assert.equal(installed.manifest.version, version);
  assert.equal(installed.settings.ok, true);
  assert.equal(installed.settings.value.hasKey, false);
  assert.equal(installed.settings.value.autoSaveFiles, false);
  report.checks.push(
    'The extracted root folder loads in actual Chrome; the English panel opens with no credentials and saving off',
  );
  await context.close();
  context = undefined;
  const sourceRoot = path.join(directory, 'source');
  extract(path.join(downloads, `${prefix}-source.zip`), sourceRoot);
  const source = path.join(sourceRoot, prefix);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))
      .version,
    version,
  );
  await fs.access(path.join(source, 'tests/fixtures/audio.mjs'));
  await fs.access(path.join(source, 'outputs/真实验收记录.md'));
  report.checks.push(
    'UTF-8 Chinese evidence filenames survive source ZIP download and extraction',
  );
  await assert.rejects(
    fs.access(path.join(source, 'outputs/原音色译音示例.wav')),
  );
  for (const args of [
    ['ci', '--registry=https://registry.npmjs.org'],
    ['run', 'verify:media-source'],
    ['run', 'check'],
    ['test'],
    ['run', 'build'],
    ['run', 'test:browser'],
  ])
    await command(args, source);
  report.checks.push(
    'A clean source ZIP installs locked dependencies, verifies MPL source, typechecks, passes unit tests, builds and passes every offline browser gate without historical recordings',
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = (
    error instanceof Error ? error.message : 'Release smoke failed'
  )
    .replaceAll(directory, '<isolated release workspace>')
    .replaceAll(root, '<project>');
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(
    'outputs/release-smoke-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
  // Keep failed logs for diagnosis; successful profiles/source dependencies are disposable.
  if (report.passed) await fs.rm(directory, { recursive: true, force: true });
}
