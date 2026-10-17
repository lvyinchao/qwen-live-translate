import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
const root = process.cwd();
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const output = path.join(root, 'outputs');
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'qvd-package-'));
const name = `timbradub-${version}`;
const zip = async (archive, cwd, entries) => {
  const files = Object.create(null);
  const walk = async (relative) => {
    const absolute = path.join(cwd, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink())
      throw new Error('Release archives must not contain symbolic links');
    if (stat.isDirectory()) {
      if (relative)
        files[relative.replaceAll(path.sep, '/') + '/'] = new Uint8Array();
      for (const name of (await fs.readdir(absolute)).sort())
        await walk(path.join(relative, name));
    } else {
      files[relative.replaceAll(path.sep, '/')] = await fs.readFile(absolute);
    }
  };
  for (const entry of entries) await walk(entry === '.' ? '' : entry);
  // The explicit ZIP implementation sets UTF-8 flags for Chinese names on every OS.
  await fs.writeFile(
    archive,
    zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) }),
  );
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
  // The installation ZIP is itself loadable after extraction. No nested root.
  await fs.cp(extension, install, { recursive: true });
  await fs.copyFile('docs/INSTALL.en.md', path.join(install, 'README.md'));
  await fs.copyFile(
    'docs/INSTALL.zh-CN.md',
    path.join(install, 'README.zh-CN.md'),
  );
  const chrome = path.join(output, `${name}-chrome.zip`);
  await zip(chrome, install, ['.']);
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
    'eslint.config.js',
    '.prettierrc.json',
    '.prettierignore',
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
  // The smoke receipt is generated after packaging and published separately;
  // including an older receipt here would attest to a different source ZIP.
  for (const file of await fs.readdir(output))
    if (file !== 'release-smoke-verification.json' &&
      (file.endsWith('.json') || file === '真实验收记录.md'))
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
