import type { PreparationStatus } from './types';

/** Targets are source-media seconds. Input remains conservatively paced at 1×. */
export function bufferPolicy(videoRate: number) {
  const rate = Number.isFinite(videoRate) ? Math.min(2, Math.max(0.5, videoRate)) : 1;
  return {
    videoRate: rate,
    startupTargetSeconds: 30 * Math.max(1, rate),
    maintainTargetSeconds: Math.min(90, 60 * Math.max(1, rate)),
    maxAheadSeconds: 90,
  };
}

export function preparationStatus(
  videoRate: number,
  inputSeconds: number,
  preparedSeconds: number,
  wallSeconds: number,
): PreparationStatus {
  const policy = bufferPolicy(videoRate);
  const inputRealtimeFactor = wallSeconds > 0 ? inputSeconds / wallSeconds : 0;
  const preparedRealtimeFactor = wallSeconds > 0 ? preparedSeconds / wallSeconds : 0;
  return {
    ...policy,
    inputRealtimeFactor,
    preparedRealtimeFactor,
    netBufferSecondsPerSecond: preparedRealtimeFactor - policy.videoRate,
    limitedByRealtimeInput: true,
  };
}
