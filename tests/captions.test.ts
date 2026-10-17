import { expect, it } from 'vitest';
import { captionPreferences, mergeCaptionPreferences } from '../lib/captions';
import { acceptEngineState } from '../lib/session';
import type { PlaybackSession } from '../lib/types';

it('migrates the old single switch without revealing captions that were turned off', () => {
  expect(captionPreferences({ subtitles: false })).toEqual({
    subtitles: false,
    sourceSubtitles: false,
    targetSubtitles: false,
  });
  expect(captionPreferences({ subtitles: true })).toEqual({
    subtitles: true,
    sourceSubtitles: true,
    targetSubtitles: true,
  });
  expect(captionPreferences()).toEqual({
    subtitles: true,
    sourceSubtitles: true,
    targetSubtitles: true,
  });
});
it('allows either line, both lines, or neither line independently', () => {
  for (const sourceSubtitles of [true, false])
    for (const targetSubtitles of [true, false])
      expect(captionPreferences({ sourceSubtitles, targetSubtitles })).toEqual({
        sourceSubtitles,
        targetSubtitles,
        subtitles: sourceSubtitles || targetSubtitles,
      });
});
it('keeps the other line when changing one new switch and retains legacy callers', () => {
  const sourceOnly = captionPreferences({ sourceSubtitles: true, targetSubtitles: false });
  expect(mergeCaptionPreferences(sourceOnly, { targetSubtitles: true })).toEqual({
    subtitles: true,
    sourceSubtitles: true,
    targetSubtitles: true,
  });
  expect(mergeCaptionPreferences(sourceOnly, { subtitles: false })).toEqual({
    subtitles: false,
    sourceSubtitles: false,
    targetSubtitles: false,
  });
  expect(
    mergeCaptionPreferences({ subtitles: false }, { subtitles: true, targetSubtitles: false }),
  ).toEqual(sourceOnly);
  expect(mergeCaptionPreferences(sourceOnly, { sourceSubtitles: 'false' })).toEqual(sourceOnly);
});
it('preserves the two user choices when delayed engine progress arrives', () => {
  const current = {
    id: 'task',
    epoch: 2,
    languageVersion: 1,
    language: 'en',
    subtitles: true,
    sourceSubtitles: false,
    targetSubtitles: true,
  } as PlaybackSession;
  expect(
    acceptEngineState(current, {
      ...current,
      stateVersion: 2,
      sourceSubtitles: true,
      targetSubtitles: false,
    }),
  ).toMatchObject({ sourceSubtitles: false, targetSubtitles: true });
});
