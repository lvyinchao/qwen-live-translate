import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = process.cwd(),
  version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const output = path.join(root, 'outputs'),
  stage = await fs.mkdtemp(path.join(os.tmpdir(), 'qvd-package-'));
try {
  const extension = path.join(output, 'extension');
  await fs.rm(extension, { recursive: true, force: true });
  await fs.cp('.output/chrome-mv3', extension, { recursive: true });
  await fs.copyFile('README.md', path.join(extension, '使用说明.md'));
  await fs.copyFile(
    'outputs/真实验收记录.md',
    path.join(extension, '真实验收记录.md'),
  );
  const archive = path.join(output, `听译-Chrome-${version}.zip`);
  await fs.rm(archive, { force: true });
  execFileSync(
    'zip',
    [
      '-q',
      '-r',
      archive,
      'extension',
      '原声对照示例.wav',
      '原音色译音示例.wav',
      '音色试听说明.md',
      '验收数据.json',
      'ui-verification.json',
      'local-files-verification.json',
      'range-source-verification.json',
      'discovery-verification.json',
      'generic-live-verification.json',
      'native-seek-verification.json',
      'native-seek-bilibili-verification.json',
      'native-tencent-translation-verification.json',
      'native-tencent-translation.png',
      'youtube-player-verification.json',
      'language-switch-verification.json',
      'language-live-verification.json',
    ],
    { cwd: output },
  );
  const source = path.join(stage, 'qwen-video-dub');
  await fs.mkdir(source);
  for (const file of [
    'entrypoints',
    'lib',
    'workers',
    'tests',
    'scripts',
    'vendor',
    'public',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    'wxt.config.ts',
    '.gitignore',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
  ])
    await fs.cp(file, path.join(source, file), { recursive: true });
  await fs.copyFile(
    'outputs/真实验收记录.md',
    path.join(source, '真实验收记录.md'),
  );
  await fs.mkdir(path.join(source, 'verification'));
  for (const file of [
    '验收数据.json',
    '原声对照示例.wav',
    '原音色译音示例.wav',
    '音色试听说明.md',
    'ui-verification.json',
    'local-files-verification.json',
    'range-source-verification.json',
    'discovery-verification.json',
    'generic-live-verification.json',
    'native-seek-verification.json',
    'native-seek-bilibili-verification.json',
    'native-tencent-translation-verification.json',
    'native-tencent-translation.png',
    'youtube-player-verification.json',
    'language-switch-verification.json',
    'language-live-verification.json',
  ])
    await fs.copyFile(
      path.join(output, file),
      path.join(source, 'verification', file),
    );
  const sourceArchive = path.join(output, `听译-源码-${version}.zip`);
  await fs.rm(sourceArchive, { force: true });
  execFileSync('zip', ['-q', '-r', sourceArchive, 'qwen-video-dub'], {
    cwd: stage,
  });
  const hashes = [];
  for (const file of [archive, sourceArchive])
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
  console.log(JSON.stringify({ extension, archive, sourceArchive }));
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
