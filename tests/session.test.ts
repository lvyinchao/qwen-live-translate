import { expect, it } from 'vitest';
import { acceptEngineState } from '../lib/session';
import type { PlaybackSession } from '../lib/types';
const base = {
  id: 'current',
  epoch: 3,
  language: 'en',
  originalVolume: 0.1,
  dubVolume: 0.8,
  subtitles: false,
} as PlaybackSession;
it('rejects old seek generations and results from a replaced task', () => {
  expect(acceptEngineState(base, { ...base, epoch: 2 })).toBe(null);
  expect(acceptEngineState(base, { ...base, id: 'old' })).toBe(null);
  expect(acceptEngineState(null, base)).toBe(null);
});
it('keeps user volume and caption choices when delayed progress arrives', () => {
  expect(
    acceptEngineState(base, {
      ...base,
      epoch: 4,
      position: 120,
      originalVolume: 0,
      dubVolume: 1,
      subtitles: true,
    }),
  ).toMatchObject({
    epoch: 4,
    position: 120,
    originalVolume: 0.1,
    dubVolume: 0.8,
    subtitles: false,
  });
});

it('rejects stale language results even if their epoch looks newer', () => {
  for (const epoch of [2, 3, 4, 50])
    expect(acceptEngineState(base, { ...base, epoch, language: 'zh' })).toBe(
      null,
    );
  const switching = { ...base, epoch: 4, language: 'ja', segments: [] };
  expect(acceptEngineState(switching, { ...base, epoch: 10 })).toBe(null);
  expect(
    acceptEngineState(switching, { ...switching, phase: 'playing' }),
  ).toMatchObject({ language: 'ja', epoch: 4, subtitles: false });
});

it('isolates language revisions across seek epochs and round trips to the same language', () => {
  const next = { ...base, epoch: 5, languageVersion: 2 };
  expect(
    acceptEngineState(next, { ...next, epoch: 100, languageVersion: 0 }),
  ).toBe(null);
  expect(
    acceptEngineState(next, { ...next, epoch: 5, languageVersion: 1 }),
  ).toBe(null);
  expect(acceptEngineState(next, { ...next, epoch: 6 })).toMatchObject({
    languageVersion: 2,
  });
});

it('rejects late retries that would revive a terminal task or rewind its progress', () => {
  const current = { ...base, phase: 'error' as const, position: 90, stateVersion: 8 };
  for (const stateVersion of [undefined, 6, 7]) {
    expect(acceptEngineState(current, { ...current, phase: 'playing', position: 20, stateVersion })).toBe(null);
  }
  expect(acceptEngineState(current, { ...current, stateVersion: 8 })).toMatchObject({ phase: 'error' });
  expect(acceptEngineState(current, { ...current, epoch: 4, phase: 'buffering', stateVersion: 1 }))
    .toMatchObject({ epoch: 4, phase: 'buffering' });
});
