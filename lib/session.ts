import type { PlaybackSession } from './types';
/** Playback progress is engine-owned; user volume/subtitle choices are UI-owned. */
export function acceptEngineState(
  current: PlaybackSession | null,
  next: PlaybackSession,
): PlaybackSession | null {
  if (!current || current.id !== next?.id || next.epoch < current.epoch)
    return null;
  return {
    ...next,
    originalVolume: current.originalVolume,
    dubVolume: current.dubVolume,
    subtitles: current.subtitles,
  };
}
