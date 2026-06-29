/**
 * `teardown()` is a `@mesh(requireAdmin)` deprovision primitive on every Nebula tier DO.
 *
 * Defined once on `NebulaDO` (the scope-deletion cascade fans out to it; a future soft-delete
 * reaper calls it after its grace window), inherited by Star/Universe/Galaxy/DevStudio. The
 * admin-surface freeze in `dev-star-data-lifecycle.test.ts` only inspects each class's OWN
 * prototype props, so it can't see an INHERITED admin method — this test closes that gap by
 * pinning `teardown` at the inheritance point: it must be mesh-callable AND guarded by exactly
 * `requireAdmin`. Capable-of-failing: dropping the `@mesh`, or swapping the guard to a non-admin
 * one, reds every row. (The wipe behavior itself is `ctx.storage.deleteAll()` — the same primitive
 * `resetDevData` already exercises behaviorally.)
 */
import { describe, it, expect } from 'vitest';
import { Star, Universe, Galaxy, DevStudio, requireAdmin } from '@lumenize/nebula';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';

describe('teardown() deprovision primitive — mesh-callable + admin-gated on every tier DO', () => {
  it.each([
    ['Star', Star],
    ['Universe', Universe],
    ['Galaxy', Galaxy],
    ['DevStudio', DevStudio],
  ])('%s.teardown is @mesh(requireAdmin)', (_name, ctor) => {
    // Resolves the inherited NebulaDO.prototype.teardown via the prototype chain.
    const fn = (ctor.prototype as unknown as Record<string, unknown>).teardown as ((...a: unknown[]) => unknown) | undefined;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn!)).toBe(true);
    expect(getMeshGuard(fn!)).toBe(requireAdmin);
  });
});
