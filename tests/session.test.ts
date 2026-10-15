import { expect, it } from 'vitest';
import { acceptEngineState } from '../lib/session';
import type { PlaybackSession } from '../lib/types';
const base = {
  id: 'current',
  epoch: 3,
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
