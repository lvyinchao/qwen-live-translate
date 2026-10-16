import type { PlaybackSession } from './types';

/** An RPC retry may arrive after a more recent snapshot from the same epoch. */
export function isOlderStateVersion(current: PlaybackSession, next: PlaybackSession) {
  return current.id === next.id &&
    current.epoch === next.epoch &&
    (current.languageVersion ?? 0) === (next.languageVersion ?? 0) &&
    (next.stateVersion ?? 0) < (current.stateVersion ?? 0);
}

/** Playback progress is engine-owned; user volume/subtitle choices are UI-owned. */
export function acceptEngineState(
  current: PlaybackSession | null,
  next: PlaybackSession,
): PlaybackSession | null {
  if (
    !current ||
    current.id !== next?.id ||
    (next.languageVersion ?? 0) !== (current.languageVersion ?? 0) ||
    next.epoch < current.epoch ||
    next.language !== current.language ||
    isOlderStateVersion(current, next)
  )
    return null;
  return {
    ...next,
    originalVolume: current.originalVolume,
    dubVolume: current.dubVolume,
    subtitles: current.subtitles,
  };
}
