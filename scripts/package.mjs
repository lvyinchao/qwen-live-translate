import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const output = path.join(root, 'outputs');
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'qvd-package-'));
const name = `timbradub-${version}`;
const zip = async (archive, cwd, entries) => {
  await fs.rm(archive, { force: true });
  execFileSync('zip', ['-q', '-r', archive, ...entries], { cwd });
};
try {
  await fs.mkdir(output, { recursive: true });
  const extension = path.join(output, 'extension');
  await fs.rm(extension, { recursive: true, force: true });
  await fs.cp('.output/chrome-mv3', extension, { recursive: true });
  // Store upload has manifest.json at ZIP root and no development/test evidence.
  const webstore = path.join(output, `${name}-webstore.zip`);
  await zip(webstore, extension, ['.']);
  const install = path.join(stage, 'install');
  await fs.mkdir(install);
  await fs.cp(extension, path.join(install, 'extension'), { recursive: true });
  for (const file of [
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'PRIVACY.md',
    'THIRD_PARTY_NOTICES.md',
  ])
    await fs.copyFile(file, path.join(install, file));
  await fs.cp('docs', path.join(install, 'docs'), { recursive: true });
  await fs.mkdir(path.join(install, 'public/brand'), { recursive: true });
  await fs.copyFile(
    'public/brand/logo.svg',
    path.join(install, 'public/brand/logo.svg'),
  );
  const chrome = path.join(output, `${name}-chrome.zip`);
  await zip(chrome, install, [
    'extension',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'PRIVACY.md',
    'THIRD_PARTY_NOTICES.md',
    'docs',
    'public',
  ]);
  const source = path.join(stage, name);
  await fs.mkdir(source);
  for (const file of [
    'entrypoints',
    'lib',
    'workers',
    'tests',
    'scripts',
    'vendor',
    'public',
    'docs',
    '.github',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    'wxt.config.ts',
    '.gitignore',
    '.gitattributes',
    '.editorconfig',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'PRIVACY.md',
    'SECURITY.md',
    'SUPPORT.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'CHANGELOG.md',
  ])
    await fs.cp(file, path.join(source, file), { recursive: true });
  await fs.mkdir(path.join(source, 'outputs'));
  // Historical text/metrics remain reproducible references. Third-party media,
  // screenshots, local profiles and credential files are not redistributed.
  for (const file of await fs.readdir(output))
    if (file.endsWith('.json') || file === '真实验收记录.md')
      await fs.copyFile(
        path.join(output, file),
        path.join(source, 'outputs', file),
      );
  const sourceArchive = path.join(output, `${name}-source.zip`);
  await zip(sourceArchive, stage, [name]);
  const hashes = [];
  for (const file of [chrome, webstore, sourceArchive])
    hashes.push(
      `${crypto
        .createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex')}  ${path.basename(file)}`,
    );
  await fs.writeFile(
    path.join(output, 'SHA256SUMS.txt'),
    hashes.join('\n') + '\n',
  );
  console.log(
    JSON.stringify({
      version,
      extension,
      chrome,
      webstore,
      source: sourceArchive,
    }),
  );
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
