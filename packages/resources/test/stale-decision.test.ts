/**
 * What a Client does with a stale answer, as a table: one row per pairing of the answer's kind,
 * whether the host is still asking, the version it names, the page's own version and what the
 * reload guard last reloaded for. Pure, which is why it needs no running system;
 * `dev-star-follows-the-build` drives the same decision through real pages.
 */
import { describe, it, expect } from 'vitest';
import { decideStale } from '../src/stale-decision';
import type { StaleInput, StaleAction } from '../src/stale-decision';

const base: StaleInput = { notice: false, checking: false, retriesLeft: true, named: 'v1', own: 'v1', reloadedFor: undefined };

describe('decideStale', () => {
  // Mutations: route a refusal naming none to `restore` (the empty-Star loop); drop the guard
  // comparison (a set-once or missing guard); skip `restore` for a notice naming the page's own
  // version; let a notice retry.
  it.each<[string, Partial<StaleInput>, StaleAction]>([
    ['a refusal while the host asks, with retries left', { checking: true, named: '' }, 'retry'],
    ['a refusal while the host asks, its retries spent, naming none', { checking: true, retriesLeft: false, named: '' }, 'resolve'],
    ['a refusal while the host asks, its retries spent, naming another version', { checking: true, retriesLeft: false, named: 'v2' }, 'reload'],
    ['a refusal naming another version', { named: 'v2' }, 'reload'],
    ['a refusal naming another version the guard already reloaded for', { named: 'v2', reloadedFor: 'v2' }, 'resolve'],
    ['a refusal naming another version, the guard holding an older one', { named: 'v3', reloadedFor: 'v2' }, 'reload'],
    ['a refusal naming none, on a Star with nothing installed', { named: '' }, 'resolve'],
    ['a refusal naming the page\'s own version', { named: 'v1' }, 'resolve'],
    ['a notice naming another version', { notice: true, named: 'v2' }, 'reload'],
    ['a notice naming another version the guard already reloaded for', { notice: true, named: 'v2', reloadedFor: 'v2' }, 'resolve'],
    ['a notice naming the page\'s own version, after an install', { notice: true, named: 'v1' }, 'restore'],
    ['a notice naming none, after a wipe', { notice: true, named: '' }, 'restore'],
    ['a notice naming none while the guard holds a version', { notice: true, named: '', reloadedFor: 'v2' }, 'restore'],
    ['a notice is never retried, even with the host asking', { notice: true, checking: true, named: '' }, 'restore'],
    ['a page with no version, told of one', { own: undefined, named: 'v1' }, 'reload'],
  ])('%s → %s', (_name, over, action) => {
    expect(decideStale({ ...base, ...over })).toBe(action);
  });
});
