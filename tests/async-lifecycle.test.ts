import { expect, it } from 'vitest';
import { SessionTransitions } from '../lib/async-lifecycle';
it('a stop invalidates a pending start before it can attach and cleanup precedes a new start', async () => {
  const tasks = new SessionTransitions();
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = tasks.invalidate();
  const first = tasks.run(async () => {
    await waiting;
    if (tasks.current(old)) events.push('old-attach');
  });
  tasks.invalidate();
  const stop = tasks.run(async () => {
    events.push('stop');
  });
  const next = tasks.invalidate();
  const start = tasks.run(async () => {
    if (tasks.current(next)) events.push('new-attach');
  });
  release();
  await Promise.all([first, stop, start]);
  expect(events).toEqual(['stop', 'new-attach']);
});
it('a failed transition does not poison later requests', async () => {
  const tasks = new SessionTransitions();
  await expect(
    tasks.run(async () => {
      throw Error('startup failed');
    }),
  ).rejects.toThrow('startup failed');
  await expect(tasks.run(async () => 'recovered')).resolves.toBe('recovered');
});
