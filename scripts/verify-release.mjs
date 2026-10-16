import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { version, license } = JSON.parse(
  await fs.readFile('package.json', 'utf8'),
);
assert.equal(license, 'MIT');
const prefix = `qwen-video-dub-${version}`;
const checksumText = await fs.readFile('outputs/SHA256SUMS.txt', 'utf8');
const checksums = new Map(
  checksumText
    .trim()
    .split('\n')
    .map((l) => l.split(/\s+/).reverse()),
);
for (const kind of ['chrome', 'webstore', 'source']) {
  const name = `${prefix}-${kind}.zip`,
    file = 'outputs/' + name;
  const bytes = await fs.readFile(file);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    checksums.get(name),
  );
  execFileSync('unzip', ['-tqq', file]);
  const paths = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((p) => p.replace(/^\.\//, ''));
  assert.ok(
    !paths.some((p) =>
      /(^|\/)(?:node_modules|\.git|work|\.env[^/]*|config\.json|[^/]*\.pem)(\/|$)/i.test(
        p,
      ),
    ),
    `${kind}: private/development files`,
  );
  if (kind === 'webstore') {
    assert.ok(paths.includes('manifest.json'));
    const manifest = JSON.parse(
      execFileSync('unzip', ['-p', file, 'manifest.json'], {
        encoding: 'utf8',
      }),
    );
    assert.equal(manifest.version, version);
    assert.equal(manifest.manifest_version, 3);
    assert.ok(
      !manifest.permissions.some((p) =>
        ['tabCapture', 'debugger', 'history'].includes(p),
      ),
    );
    for (const size of [16, 32, 48, 128])
      assert.ok(paths.includes(manifest.icons[size]));
    for (const required of [
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'licenses/mediabunny-MPL-2.0.txt',
      'licenses/mediabunny-1.61.4-source.tgz',
    ])
      assert.ok(paths.includes(required), required);
    assert.ok(
      !paths.some((p) => /\.(wav|pcm|mp4)$/.test(p)),
      'No validation recordings in the store package',
    );
  }
  if (kind === 'chrome') assert.ok(paths.includes('extension/manifest.json'));
  if (kind === 'source')
    for (const required of [
      'LICENSE',
      'package-lock.json',
      'vendor/googlevideo-4.1.1-qvd.96d1418.tgz',
      'vendor/mediabunny-1.61.4-source.tgz',
      'scripts/package.mjs',
      '.github/workflows/ci.yml',
    ])
      assert.ok(paths.includes(`${prefix}/${required}`), required);
  console.log(`Verified ${name}: checksum, CRC, layout and licensing`);
}
