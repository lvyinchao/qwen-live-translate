import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Enforce that the MPL source archive corresponds to the library actually bundled. */
export async function checkMediaSource() {
  const project = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
  const installed = JSON.parse(
    await fs.readFile('node_modules/mediabunny/package.json', 'utf8'),
  );
  const locked = lock.packages['node_modules/mediabunny'];
  assert.equal(
    project.dependencies.mediabunny,
    installed.version,
    'Pin the exact Mediabunny version whose source is shipped',
  );
  assert.equal(
    installed.version,
    locked.version,
    'Installed Mediabunny differs from the lockfile',
  );
  const filename = `mediabunny-${locked.version}-source.tgz`;
  const archive = `vendor/${filename}`;
  const bytes = await fs.readFile(archive);
  const sri = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(
    sri,
    locked.integrity,
    'Vendored MPL source differs from the locked npm tarball',
  );
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', archive, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(manifest.name, 'mediabunny');
  assert.equal(manifest.version, installed.version);
  const source = execFileSync(
    'tar',
    ['-xzOf', archive, 'package/src/index.ts'],
    { encoding: 'utf8' },
  );
  assert.ok(
    source.length > 1000,
    'The MPL distribution must include readable source',
  );
  return { version: installed.version, filename, archive, integrity: sri };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await checkMediaSource();
  console.log(
    `Verified Mediabunny ${result.version}: installed version, lockfile SHA-512 and corresponding readable source`,
  );
}
