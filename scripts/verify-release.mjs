import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkMediaSource } from './check-media-source.mjs';
import { unzipSync } from 'fflate';

const { version, license } = JSON.parse(
  await fs.readFile('package.json', 'utf8'),
);
assert.equal(license, 'MIT');
const mediaSource = await checkMediaSource();
const prefix = `timbradub-${version}`;
const checksumText = await fs.readFile('outputs/SHA256SUMS.txt', 'utf8');
const checksums = new Map(
  checksumText
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})  ([^\r\n]+)$/);
      assert.ok(match, 'Malformed release checksum entry');
      return [match[2], match[1]];
    }),
);
assert.equal(
  checksums.size,
  3,
  'The checksum file must describe exactly the three release archives',
);
const readEntry = (archiveEntries, entry) => {
  const value = archiveEntries[entry];
  assert.ok(value, 'Missing archive entry: ' + entry);
  return Buffer.from(value);
};
const jsonEntry = (archive, entry) =>
  JSON.parse(readEntry(archive, entry).toString('utf8'));
const sensitive = [
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bLTAI[A-Za-z0-9]{12,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /https?:\/\/[^\s/'"<>]+:[A-Za-z0-9_-]{24,}@/i,
  /https?:\/\/[^\s'"<>]*[?&](?:signature|sign|sig|auth_key|wssecret|token|access_token)=[A-Za-z0-9_%.-]{24,}/i,
];

for (const kind of ['chrome', 'webstore', 'source']) {
  const name = `${prefix}-${kind}.zip`,
    file = `outputs/${name}`;
  const bytes = await fs.readFile(file);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    checksums.get(name),
  );
  execFileSync('unzip', ['-tqq', file]);
  const archiveEntries = unzipSync(bytes);
  const entries = Object.keys(archiveEntries);
  const paths = entries.map((p) => p.replace(/^\.\//, ''));
  assert.ok(
    !paths.some((p) => p.startsWith('/') || p.split('/').includes('..')),
    `${kind}: unsafe archive path`,
  );
  assert.ok(
    !paths.some((p) =>
      /(^|\/)(?:node_modules|\.git|work|\.env[^/]*|config\.json|[^/]*\.(?:pem|key))(\/|$)/i.test(
        p,
      ),
    ),
    `${kind}: private/development files`,
  );
  for (let index = 0; index < entries.length; index++) {
    if (
      !/\.(?:[cm]?js|[cm]?tsx?|json|md|ya?ml|html|txt|svg)$/i.test(paths[index])
    )
      continue;
    const content = readEntry(archiveEntries, entries[index]).toString('utf8');
    assert.ok(
      !sensitive.some((pattern) => pattern.test(content)),
      `${kind}: possible secret in ${paths[index]}`,
    );
  }
  if (kind !== 'source') {
    assert.ok(
      paths.includes('manifest.json'),
      `${kind}: choose the extracted root directly`,
    );
    assert.ok(
      !paths.includes('extension/manifest.json'),
      `${kind}: unexpected nested installation folder`,
    );
    const manifest = jsonEntry(archiveEntries, 'manifest.json');
    assert.equal(manifest.version, version);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.default_locale, 'en');
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
      `licenses/${mediaSource.filename}`,
    ])
      assert.ok(paths.includes(required), required);
    assert.equal(
      `sha512-${crypto
        .createHash('sha512')
        .update(readEntry(archiveEntries, `licenses/${mediaSource.filename}`))
        .digest('base64')}`,
      mediaSource.integrity,
      `${kind}: corresponding MPL source mismatch`,
    );
    assert.ok(
      !paths.some((p) => /\.(wav|pcm|mp4)$/.test(p)),
      'No validation recordings in installation packages',
    );
    if (kind === 'chrome')
      for (const instruction of ['README.md', 'README.zh-CN.md'])
        assert.ok(paths.includes(instruction));
  } else {
    for (const required of [
      'LICENSE',
      'package-lock.json',
      'vendor/googlevideo-4.1.1-qvd.96d1418.tgz',
      `vendor/${mediaSource.filename}`,
      'tests/fixtures/audio.mjs',
      'scripts/release-smoke.mjs',
      '.github/workflows/validate.yml',
    ])
      assert.ok(paths.includes(`${prefix}/${required}`), required);
    assert.equal(
      jsonEntry(archiveEntries, `${prefix}/package.json`).version,
      version,
    );
    assert.equal(
      `sha512-${crypto
        .createHash('sha512')
        .update(
          readEntry(archiveEntries, `${prefix}/vendor/${mediaSource.filename}`),
        )
        .digest('base64')}`,
      mediaSource.integrity,
      'Source archive MPL mismatch',
    );
    assert.ok(
      !paths.some(
        (p) => p.startsWith(`${prefix}/outputs/`) && /\.(wav|pcm|mp4)$/.test(p),
      ),
      'Historical recordings are excluded from the source archive',
    );
  }
  console.log(
    `Verified ${name}: SHA-256, CRC, directly loadable layout, secrets and corresponding MPL source`,
  );
}
