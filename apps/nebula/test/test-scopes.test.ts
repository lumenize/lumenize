/**
 * The deployed venue's test names and its certificate-pack sweep (`harness/lib/test-scopes.ts`).
 *
 * In-lane on purpose (`live.md` § *`/live` is the DEFAULT tier*): the predicate is a pure function of
 * a pack's hosts and the date, and the local stack orders no packs, so no running system reaches it
 * before a deployment. The deployed pass runs the sweep against the test zone.
 */
import { describe, it, expect } from 'vitest';
import { isValidSlug } from '@lumenize/nebula-auth';
import { isStaleTestPack, sweepStaleTestPacks, testLabelDate, testSlug } from '../harness/lib/test-scopes';

const ZONE = 'lumenize-test.dev';
const NOW = new Date('2026-10-03T12:00:00.000Z');
const pack = (galaxyHost: string) => [ZONE, galaxyHost, `*.${galaxyHost}`];

describe('test names', () => {
  it('mint a legal host label carrying the UTC day', () => {
    const slug = testSlug('render', NOW);
    expect(slug).toMatch(/^test-1003-render[a-z0-9]{6}$/);
    expect(isValidSlug(slug)).toBe(true);
    expect(testLabelDate(slug, NOW)?.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(() => testSlug('a-label-far-too-long-for-a-host', NOW)).toThrow(/not a legal host label/);
  });

  it('read a December label in January as last year', () => {
    expect(testLabelDate('test-1230-abc', new Date('2027-01-02T00:00:00.000Z'))?.toISOString())
      .toBe('2026-12-30T00:00:00.000Z');
    expect(testLabelDate('test-1340-abc', NOW)).toBeUndefined();
    expect(testLabelDate('crm', NOW)).toBeUndefined();
  });
});

describe('the sweep deletes only test packs older than its window', () => {
  it("deletes an old run's pack and keeps a concurrent run's", () => {
    expect(isStaleTestPack(pack(`crm.test-0920-abc.${ZONE}`), ZONE, NOW)).toBe(true);
    expect(isStaleTestPack(pack(`crm.test-1003-abc.${ZONE}`), ZONE, NOW)).toBe(false);
  });

  it('keeps a pack naming no test label, and the Universal pack', () => {
    expect(isStaleTestPack(pack(`crm.acme.${ZONE}`), ZONE, NOW)).toBe(false);
    expect(isStaleTestPack([ZONE, `*.${ZONE}`], ZONE, NOW)).toBe(false);
  });

  it('dates a pack by its newest test label', () => {
    expect(isStaleTestPack(pack(`test-1003-g.test-0901-u.${ZONE}`), ZONE, NOW)).toBe(false);
  });

  it('counts only hosts inside the zone', () => {
    // Shares the zone's name as a bare suffix, so a check without the dot would count it too.
    expect(isStaleTestPack(pack('crm.test-0901-abc.notlumenize-test.dev'), ZONE, NOW)).toBe(false);
  });

  it('a December pack read in January is old', () => {
    expect(isStaleTestPack(pack(`crm.test-1225-abc.${ZONE}`), ZONE, new Date('2027-01-02T12:00:00.000Z'))).toBe(true);
  });

  it('deletes each stale pack and reports a failed delete without stopping', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const deleted = await sweepStaleTestPacks({
      list: async () => [
        { id: 'old', hosts: pack(`crm.test-0901-a.${ZONE}`) },
        { id: 'stuck', hosts: pack(`crm.test-0902-b.${ZONE}`) },
        { id: 'today', hosts: pack(`crm.test-1003-c.${ZONE}`) },
        { id: 'older', hosts: pack(`crm.test-0903-d.${ZONE}`) },
      ],
      delete: async (id) => { calls.push(id); if (id === 'stuck') throw new Error('answered 500'); },
    }, ZONE, NOW, (l) => lines.push(l));
    expect(calls).toEqual(['old', 'stuck', 'older']);
    expect(deleted).toEqual(['old', 'older']);
    expect(lines.some((l) => l.includes('stuck') && l.includes('answered 500'))).toBe(true);
  });
});
