import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = process.cwd();
const installed = JSON.parse(
  readFileSync(
    path.join(project, 'node_modules/mediabunny/package.json'),
    'utf8',
  ),
);
const lock = JSON.parse(
  readFileSync(path.join(project, 'package-lock.json'), 'utf8'),
);
let directory: string;
const run = () =>
  execFileSync(
    process.execPath,
    [path.join(project, 'scripts/check-media-source.mjs')],
    { cwd: directory, stdio: 'pipe' },
  );
const write = (name: string, data: unknown) =>
  writeFileSync(path.join(directory, name), JSON.stringify(data));

beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'timbradub-source-check-'));
  mkdirSync(path.join(directory, 'vendor'));
  mkdirSync(path.join(directory, 'node_modules/mediabunny'), {
    recursive: true,
  });
  copyFileSync(
    path.join(project, `vendor/mediabunny-${installed.version}-source.tgz`),
    path.join(directory, `vendor/mediabunny-${installed.version}-source.tgz`),
  );
  write('package.json', { dependencies: { mediabunny: installed.version } });
  write('package-lock.json', lock);
  write('node_modules/mediabunny/package.json', installed);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('accepts the installed library only with its locked corresponding readable source', () => {
  expect(run().toString()).toContain('corresponding readable source');
});
it('rejects a different installed library before packaging', () => {
  write('node_modules/mediabunny/package.json', {
    ...installed,
    version: '99.0.0',
  });
  try {
    expect(run).toThrow();
  } finally {
    write('node_modules/mediabunny/package.json', installed);
  }
});
it('rejects mismatching npm tarball integrity before packaging', () => {
  const changed = structuredClone(lock);
  changed.packages['node_modules/mediabunny'].integrity = 'sha512-invalid';
  write('package-lock.json', changed);
  try {
    expect(run).toThrow();
  } finally {
    write('package-lock.json', lock);
  }
});
