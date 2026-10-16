import { expect, it } from 'vitest';
import { ObservationScope } from '../lib/observation-scope';
it('observes only a selected tab, expires leases, and retains an active translation', () => {
  let now = 0;
  const scope = new ObservationScope(() => now, 100);
  expect(scope.allows(3)).toBe(false);
  scope.watch(3);
  expect(scope.allows(3)).toBe(true);
  expect(scope.allows(4)).toBe(false);
  now = 101;
  expect(scope.expired()).toEqual([3]);
  expect(scope.allows(3)).toBe(false);
  expect(scope.allows(3, 3)).toBe(true);
  scope.watch(4);
  scope.release(4);
  expect(scope.allows(4)).toBe(false);
});
