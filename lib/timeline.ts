import type { TranslationSegment } from './types';

export interface Coverage {
  start: number;
  end: number;
}
export function mergeCoverage(ranges: Coverage[]): Coverage[] {
  const out: Coverage[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start)
      continue;
    const last = out.at(-1);
    if (last && range.start <= last.end + 0.02) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}
export function coverageEnd(ranges: Coverage[], position: number): number {
  return (
    mergeCoverage(ranges).find((r) => r.start <= position + 0.03 && r.end > position)?.end ??
    position
  );
}
export function planDub(
  segment: Pick<TranslationSegment, 'start' | 'end' | 'audioDuration'>,
  position: number,
  videoRate: number,
) {
  const span = Math.max(0.05, segment.end - segment.start);
  const stretch = Math.max(1, segment.audioDuration / span);
  const rate = Math.min(2, Math.max(0.25, videoRate * stretch));
  const offset = (Math.max(0, position - segment.start) / videoRate) * rate;
  return {
    rate,
    offset,
    expired: position >= segment.end || offset >= segment.audioDuration,
    truncated: segment.audioDuration / rate > span / videoRate + 0.05,
  };
}
export function activeSegment(
  segments: TranslationSegment[],
  position: number,
): TranslationSegment | undefined {
  // A newly-started turn wins over an overlapping previous turn.
  return segments
    .filter((s) => s.start <= position && s.end > position)
    .sort((a, b) => b.start - a.start)[0];
}

/** Detect a player reset or jump even when a site omits the seeking event. */
export function clockDiscontinuity(
  previous: number,
  current: number,
  elapsedSeconds: number,
  rate: number,
): boolean {
  return (
    current < previous - 0.3 ||
    current - previous > Math.max(2, Math.max(0, elapsedSeconds) * Math.max(1, rate) + 0.5)
  );
}
