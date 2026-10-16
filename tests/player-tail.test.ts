import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { activeSegment, planDub, clockDiscontinuity } from '../lib/timeline';
import { isOlderStateVersion } from '../lib/session';

// Exercise the actual content-script methods without a synthetic reimplementation
// of the scheduler. Browser playback is covered separately by the Chromium gate.
const source = readFileSync('entrypoints/player.content.ts', 'utf8');
const classSource = source.slice(source.indexOf('    class Player {'),
  source.indexOf('    chrome.runtime.onMessage.addListener'));
const javascript = ts.transpileModule(classSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const Player = new Function('activeSegment', 'planDub', 'clockDiscontinuity',
  'isOlderStateVersion', 'decode64', 't', 'locale', `${javascript}; return Player;`)(
  activeSegment, planDub, clockDiscontinuity, isOlderStateVersion,
  () => new Uint8Array([0]), (_locale: string, message: string) => message, 'en');
class AudioFixture extends EventTarget {
  src = 'blob:fixture';
  get currentSrc() { return this.src; }
  currentTime = 0.74;
  duration = 0.8;
  paused = false;
  ended = false;
  readyState = 1;
  playbackRate = 1;
  volume = 1;
  preservesPitch = true;
  preload = '';
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('playing')); });
  load = vi.fn();
  remove = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
}
const segment = (overrides: Record<string, unknown> = {}) => ({
  id: 'short', start: 0, end: 2, audioDuration: 0.8, audio: 'AA==', text: 'test', sourceText: '', ...overrides,
});
function fixture(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1 });
  vi.stubGlobal('document', { createElement: () => ({ className: '', textContent: '' }) });
  const current = segment();
  const events: any[] = [];
  const player = Object.assign(Object.create(Player.prototype), {
    abort: new AbortController(), video: { currentTime: 0.81, playbackRate: 1,
      paused: false, muted: true, volume: 0, pause: vi.fn(), play: vi.fn(async () => {}) },
    session: { id: 'task', epoch: 1, languageVersion: 0, language: 'zh', phase: 'playing',
      readyThrough: 30, stateVersion: 4, candidate: { duration: 100 }, dubVolume: 1 },
    audio: new AudioFixture(), audioListeners: new Map(),
    current, segments: [current], anchor: { media: 0, audio: 0 }, blob: 'blob:fixture',
    currentPreloadHit: true, tickGapMs: 0, maxTickGapMs: 0,
    started: new Set(['short']), skipped: new Set(), terminated: new Set(), endedMetrics: new Set(), pendingTerminals: [],
    waiting: false, loaded: true, caption: { replaceChildren: vi.fn() },
    host: { remove: vi.fn() }, original: { muted: false, volume: 0.35 },
    epochStartPosition: 0, preloadUpcoming: vi.fn(),
    send: (type: string, data: Record<string, unknown>) => events.push({ type, ...data }),
    ...overrides,
  });
  player.configureAudio(player.audio);
  return { player, events, terminals: () => events.filter((event) => event.kind === 'terminal') };
}
afterEach(() => vi.unstubAllGlobals());

it('finishes a real 60 ms short tail after its ideal end instead of pausing or seeking it away', () => {
  const f = fixture();
  f.player.tick();
  expect(f.player.audio.pause).not.toHaveBeenCalled();
  expect(f.player.audio.currentTime).toBe(0.74);
  expect(f.terminals()).toEqual([]);
  f.player.audio.currentTime = 0.8;
  f.player.audio.ended = true;
  f.player.audio.dispatchEvent(new Event('ended'));
  f.player.tick();
  expect(f.terminals()).toMatchObject([{ reason: 'natural', remaining: 0, sourceTime: 0.81 }]);
  expect(f.events.filter((event) => event.kind === 'end')).toHaveLength(1);
  expect(f.events.filter((event) => event.type === 'player:skip')).toEqual([]);
});

it('records even a 60 ms cut at the source boundary and never reports it as a natural completion', () => {
  const f = fixture();
  f.player.video.currentTime = 2.01;
  f.player.tick();
  expect(f.terminals()).toHaveLength(1);
  expect(f.terminals()[0]).toMatchObject({ reason: 'timeline-cut', sourceTime: 2.01, audioTime: 0.74 });
  expect(f.terminals()[0].remaining).toBeCloseTo(0.06);
  expect(f.events.filter((event) => event.type === 'player:skip')).toHaveLength(1);
  expect(f.player.current).toBeUndefined();
  f.player.tick();
  expect(f.terminals()).toHaveLength(1);
});

it('does not replay naturally finished audio when tick observes ended before the queued native event', () => {
  const f = fixture();
  f.player.audio.currentTime = 0.8;
  f.player.audio.ended = true;
  f.player.audio.paused = true;
  f.player.tick();
  f.player.audio.dispatchEvent(new Event('ended'));
  f.player.audio.dispatchEvent(new Event('ended'));
  f.player.tick();
  expect(f.player.audio.play).not.toHaveBeenCalled();
  expect(f.player.audio.currentTime).toBe(0.8);
  expect(f.terminals()).toHaveLength(1);
  expect(f.terminals()[0].reason).toBe('natural');
  expect(f.events.filter((event) => event.kind === 'end')).toHaveLength(1);
});

it('cuts the previous turn once and starts a preloaded overlapping turn without accumulating a tail', async () => {
  const f = fixture();
  const next = segment({ id: 'next', start: 1.5, end: 3, audioDuration: 1 });
  const audio = new AudioFixture(); audio.src = 'blob:next'; audio.currentTime = 0;
  audio.duration = 1; audio.paused = true;
  f.player.configureAudio(audio);
  f.player.preloaded = { segment: next, audio, blob: 'blob:next' };
  f.player.segments.push(next);
  f.player.video.currentTime = 1.51;
  f.player.tick();
  await Promise.resolve();
  expect(f.terminals()).toMatchObject([{ reason: 'overlap-cut', segmentId: 'short' }]);
  expect(f.player.current.id).toBe('next');
  expect(f.player.audio).toBe(audio);
  expect(audio.paused).toBe(false);
  expect(audio.play).toHaveBeenCalledOnce();
  expect(f.events.find((event) => event.kind === 'start' && event.segmentId === 'next'))
    .toMatchObject({ preloadHit: true, readyState: 1, stateVersion: 4, readyThrough: 30 });
});

it('keeps pause/resume and changed speed in force while a real tail finishes', async () => {
  const f = fixture();
  f.player.video.paused = true;
  f.player.tick();
  expect(f.player.audio.paused).toBe(true);
  expect(f.terminals()).toEqual([]);
  f.player.video.paused = false;
  f.player.video.playbackRate = 1.5;
  f.player.anchor = { media: 0.81, audio: 0.74 };
  f.player.video.currentTime = 0.88;
  f.player.tick();
  await Promise.resolve();
  expect(f.player.audio.paused).toBe(false);
  expect(f.player.audio.playbackRate).toBe(1.5);
  expect(f.player.audio.currentTime).toBe(0.74);
  expect(f.terminals()).toEqual([]);
});

it('retains the absolute 2x audio limit for a long utterance', () => {
  const current = segment({ audioDuration: 5 });
  const f = fixture({ current, segments: [current] });
  f.player.video.playbackRate = 2;
  f.player.video.currentTime = 0.1;
  f.player.audio.currentTime = 0.1;
  f.player.tick();
  expect(f.player.audio.playbackRate).toBe(2);
});

it.each(['seek-stop', 'language-switch', 'stop', 'error', 'video-ended', 'player-lost'])(
  'records %s exactly once and returns the old revision for explicit diagnostic delivery', (reason) => {
    const f = fixture();
    f.player.clearAudio(true, reason);
    f.player.clearAudio(true, reason);
    expect(f.terminals()).toMatchObject([{ reason, segmentId: 'short' }]);
    expect(f.events.filter((event) => event.type === 'player:skip')).toEqual([]);
    expect(f.player.takeTerminals()).toMatchObject([{ sessionId: 'task', epoch: 1,
      languageVersion: 0, type: 'player:metric', kind: 'terminal', reason }]);
    expect(f.player.takeTerminals()).toEqual([]);
  },
);

it('captures preload metadata and frontend play timing with a measurable scheduler gap', async () => {
  const f = fixture({ started: new Set() });
  const next = segment({ id: 'next', start: 4, end: 5 });
  const preload = new AudioFixture(); preload.src = 'blob:next';
  f.player.preloaded = { audio: preload, segment: next, blob: 'blob:next' };
  f.player.configureAudio(preload);
  preload.dispatchEvent(new Event('loadedmetadata'));
  f.player.audio.paused = true;
  f.player.previousTickAt = performance.now() - 500;
  f.player.tick();
  await Promise.resolve();
  const stage = (name: string) => f.events.find((event) => event.kind === 'audio-stage' && event.stage === name);
  expect(stage('metadata')).toMatchObject({ segmentId: 'next', preloadHit: true, readyState: 1 });
  for (const name of ['play-call', 'playing', 'play-resolved']) {
    expect(stage(name)).toMatchObject({ segmentId: 'short', videoTime: 0.81, audioTime: 0.74,
      preloadHit: true, stateVersion: 4, readyThrough: 30 });
    expect(stage(name).frontendAt).toBeGreaterThan(0);
    expect(stage(name).maxTickGapMs).toBeGreaterThanOrEqual(500);
  }
});
