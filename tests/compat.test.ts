import { describe, expect, it } from 'vitest';
import {
  captureShouldPause,
  CaptureClock,
  compatError,
  compatCanPlay,
  COMPAT_DISK_LIMIT,
} from '../lib/compat';
import { planDub } from '../lib/timeline';
describe('captured-video buffering', () => {
  it('waits for thirty translated and playable seconds initially, or the remaining tail', () => {
    expect(compatCanPlay(0, 30, 29, false, true)).toBe(false);
    expect(compatCanPlay(0, 30, 30, false, true)).toBe(true);
    expect(compatCanPlay(0, 8, 8, true, true)).toBe(true);
    expect(compatCanPlay(10, 10.1, 60, false, false)).toBe(false);
  });
  it('stops acquisition when playback or translation falls behind, with hysteresis', () => {
    expect(captureShouldPause(100, 80, 0, false)).toBe(true);
    expect(captureShouldPause(100, 10, 80, false)).toBe(true);
    expect(captureShouldPause(80, 50, 0, true)).toBe(true);
    expect(captureShouldPause(80, 40, 30, true)).toBe(true);
    expect(captureShouldPause(80, 50, 30, true)).toBe(false);
  });
  it('uses the recording timeline rather than network arrival time', () => {
    const utterance = { start: 30, end: 33, audioDuration: 4 };
    expect(planDub(utterance, 30, 1).offset).toBe(0);
    expect(planDub(utterance, 31, 1).offset).toBeCloseTo(4 / 3);
    expect(planDub(utterance, 33, 1).expired).toBe(true);
    expect(planDub(utterance, 31, 2).rate).toBe(2);
    expect(COMPAT_DISK_LIMIT).toBe(2 * 1024 ** 3);
  });
});

it('explains Chrome tab capture invocation in both interface languages', () => {
  const error =
    'Extension has not been invoked for the current page (see activeTab permission).';
  expect(compatError(error, 'en')).toContain('toolbar icon');
  expect(compatError(error, 'zh')).toContain('工具栏图标');
});

it('bounds the producer even when decoded samples arrive late and excludes recording pauses', () => {
  const c = new CaptureClock();
  c.start(10000);
  expect(
    captureShouldPause(Math.max(84, c.seconds(101000)), 60, 0, false),
  ).toBe(true);
  c.pause(101000);
  c.pause(110000);
  expect(c.seconds(150000)).toBe(91);
  c.resume(151000);
  expect(c.seconds(160000)).toBe(100);
});
