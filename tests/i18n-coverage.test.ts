import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { localizeMessage } from '../lib/i18n';

const root = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
// User-facing failures are written in Chinese and localized by their text, so
// a reworded message must not silently lose its English translation.
const MESSAGE =
  /(?:Error\(\s*|AppError\(\s*'[a-z-]+',\s*|reason:\s*|sourceReason:\s*)'([^'\n]*[一-龥][^'\n]*)'/g;

it('has an English translation for every literal user-facing error message', () => {
  const missing = ['lib', 'entrypoints', 'workers']
    .flatMap((dir) => sources(join(root, dir)))
    .flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(MESSAGE)]
        .map((match) => match[1]!)
        .filter((message) => localizeMessage(message, 'en') === message)
        .map((message) => `${relative(root, file)}: ${message}`),
    );
  expect(missing).toEqual([]);
});
