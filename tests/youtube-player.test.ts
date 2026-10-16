import { expect, it } from 'vitest';
import { youtubePlayer, bilibiliPlayer, type inspectVideos } from '../lib/discovery';
type Video = ReturnType<typeof inspectVideos>[number];
const video = (extra: Partial<Video>): Video => ({
  id: 'main',
  title: 'Video',
  poster: '',
  duration: 120,
  currentTime: 5,
  width: 1280,
  height: 720,
  paused: false,
  playbackRate: 1,
  index: 0,
  url: 'blob:https://www.youtube.com/stream',
  frameUrl: 'https://www.youtube.com/watch?v=sample',
  protected: false,
  displayed: true,
  displayWidth: 640,
  displayHeight: 360,
  youtubeMain: true,
  bilibiliMain: false,
  cctvMain: false,
  ...extra,
});
it('keeps only the active main player, not a hidden higher resolution or an oversized preview', () => {
  expect(
    youtubePlayer([
      video({ id: 'old-4k', width: 3840, height: 2160, displayed: false }),
      video({
        id: 'preview',
        youtubeMain: false,
        displayWidth: 3840,
        displayHeight: 2160,
      }),
      video({ id: 'main' }),
    ]).map((v) => v.id),
  ).toEqual(['main']);
});
it('returns one control target while a new main-player variant is mounted', () => {
  expect(
    youtubePlayer([
      video({ id: 'old', paused: true }),
      video({ id: 'active', index: 1 }),
    ]).map((v) => v.id),
  ).toEqual(['active']);
  expect(youtubePlayer([video({ displayed: false })])).toEqual([]);
});

it('keeps Bilibili native metadata bound to the main player rather than a preview', () => {
  expect(bilibiliPlayer([
    video({id: 'preview', displayWidth: 2000, displayHeight: 1000}),
    video({id: 'main', bilibiliMain: true}),
    video({id: 'hidden-main', bilibiliMain: true, displayed: false}),
  ]).map((item) => item.id)).toEqual(['main']);
});
