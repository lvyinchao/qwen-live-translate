import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

it('clean-source test subprocesses exclude unrelated secrets, live flags and external builds', () => {
  const moduleUrl = pathToFileURL(path.resolve('scripts/test-environment.mjs')).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { isolatedTestEnv } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(isolatedTestEnv({ HEADLESS: '1' })));
  `,
    ],
    {
      encoding: 'utf8',
      env: {
        HOME: '/fixture-home',
        PATH: ['/external-checkout/node_modules/.bin', '/usr/bin'].join(path.delimiter),
        ANTHROPIC_AUTH_TOKEN: 'fixture-value',
        BAILIAN_API_KEY: 'fixture-value',
        LIVE_YOUTUBE: '1',
        EXTENSION_DIR: '/external-build',
      },
    },
  );
  expect(JSON.parse(result)).toEqual({
    HOME: '/fixture-home',
    PATH: '/usr/bin',
    HEADLESS: '1',
  });
});
