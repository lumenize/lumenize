/**
 * `/_version` build-compare endpoint — dev-safe + compare-only (Phase 1: nebula-release-process.md).
 *
 * Drives the REAL Nebula entrypoint via `Browser().fetch` (baseline `index.ts` re-exports
 * `entrypoint as default`). Under vitest-pool-workers no `--define` is injected, so the build
 * stamp falls back to the dev sentinel (`buildSha() === 'dev'`, `buildDirty() === true`). This
 * pins the two invariants the deploy/staleness machinery depends on:
 *   1. Dev-safe — reading the absent `__GIT_SHA__`/`__DIRTY__` globals through the `typeof` guard
 *      NEVER throws (a bare reference would ReferenceError + break the whole suite).
 *   2. Compare-only / non-disclosing — the worker replies `{ match, dirty }` only; it never echoes
 *      the deployed SHA (or buildTime, or a dep list) in the body.
 *
 * Capable-of-failing: a real 40-hex SHA can never equal the `'dev'` sentinel, so `match` MUST be
 * false here — gutting the compare to always-true reds case 1; echoing the SHA reds case 2.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';

const ORIGIN = 'http://localhost';
const REAL_SHA = 'abc123def456abc123def456abc123def456abcd'; // a plausible 40-hex SHA, never 'dev'

describe('/_version build-compare endpoint (dev-safe, compare-only)', () => {
  it('a real SHA never matches the dev sentinel → { match:false, dirty:true } (never throws)', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/_version?sha=${REAL_SHA}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ match: false, dirty: true });
  });

  it('discloses nothing — body has exactly {match,dirty}, never the SHA/buildTime', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/_version?sha=whatever`);
    const body = (await res.json()) as Record<string, unknown>;
    // Exactly these two keys — a disclosure mutation (echoing the SHA under any key) reds this.
    expect(Object.keys(body).sort()).toEqual(['dirty', 'match']);
    // The dev sentinel value must never appear as a disclosed body value either.
    expect(JSON.stringify(body)).not.toContain('dev');
  });

  it('a missing ?sha never spuriously matches', async () => {
    const res = await new Browser().fetch(`${ORIGIN}/_version`);
    expect((await res.json() as { match: boolean }).match).toBe(false);
  });

  it('submitting the dev sentinel itself matches (proves the compare is real, not hardcoded false)', async () => {
    // Positive anchor: the only value that matches in dev is `'dev'`. This proves `match:false`
    // above is a genuine comparison result, not a constant — the mutation-pair for case 1.
    const res = await new Browser().fetch(`${ORIGIN}/_version?sha=dev`);
    expect((await res.json() as { match: boolean }).match).toBe(true);
  });
});
