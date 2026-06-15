/**
 * Rich-type round-trip (ADR-002) — a resource value carrying Map / Date / Set
 * and a cycle survives create → real wire → storage → re-read → fanout with type
 * AND reference identity intact. This is the no-mock backing for ADR-002's
 * "every surface round-trips the full structured-clone value space"; a harness
 * that JSON-stringified anywhere would degrade Date→string / Map→{} / Set→[] and
 * flatten the cycle, so these `instanceof` + identity assertions are the
 * degradation probe (testing.md § capable-of-failing).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const RICH_TYPES = `interface RichResource {
  label: string;
  when: Date;
  counts: Map<string, number>;
  tags: Set<string>;
  blob?: unknown;
}`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function setupAdminClient(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: RICH_TYPES });
  await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });
  return a;
}

describe('rich-type round-trip (ADR-002, real Star)', () => {
  it('Map / Date / Set survive create → re-read with type intact', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const when = new Date('2026-01-02T03:04:05.678Z');
    const counts = new Map<string, number>([['a', 1], ['b', 2]]);
    const tags = new Set(['x', 'y']);

    const outcome = await client.resources.transaction({
      [resourceId]: {
        op: 'create', typeName: 'RichResource', nodeId: ROOT_NODE_ID,
        value: { label: 'rich', when, counts, tags },
      },
    });
    expect(outcome.kind).toBe('committed');

    const snap = await client.resources.read('RichResource', resourceId);
    const v = snap!.value as { label: string; when: Date; counts: Map<string, number>; tags: Set<string> };

    expect(v.label).toBe('rich');
    expect(v.when).toBeInstanceOf(Date);
    expect(v.when.toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(v.counts).toBeInstanceOf(Map);
    expect(v.counts.get('a')).toBe(1);
    expect(v.counts.get('b')).toBe(2);
    expect(v.tags).toBeInstanceOf(Set);
    expect(v.tags.has('x')).toBe(true);

    client[Symbol.dispose]();
  });

  // A cycle WITHIN a single resource value round-trips with reference identity.
  // ADR-002 scopes the full structured-clone space (cycles, aliases, Map/Date/Set)
  // to what lives INSIDE one value; ADR-006 scopes references BETWEEN resources to
  // ids (a relationship field is rewritten to `string` in the write shape, so an
  // embedded object there is a loud by-id error — that's NOT a cycle gap, and is
  // covered by ts-runtime-parser-validator's relationship-write-shape.test.ts). So
  // the cycle here lives in a loosely-typed `blob` value field (NOT a relationship),
  // exercising the wire + storage + read surfaces end-to-end (the validator surface
  // is covered by that unit test; this is the no-mock ADR-002 within-value proof).
  it('a within-value cycle survives create → real wire → storage → re-read with identity', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const blob: any = { tag: 'inner' };
    blob.loop = blob; // direct cycle inside the value's `blob` field (within-value, not a reference)
    const value: Record<string, unknown> = {
      label: 'cyclic', when: new Date('2026-01-02T03:04:05.678Z'),
      counts: new Map<string, number>(), tags: new Set<string>(), blob,
    };

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'RichResource', nodeId: ROOT_NODE_ID, value },
    });
    expect(outcome.kind).toBe('committed');

    const snap = await client.resources.read('RichResource', resourceId);
    const v = snap!.value as { label: string; blob: { tag: string; loop: unknown } };
    expect(v.label).toBe('cyclic');
    expect(v.blob.tag).toBe('inner');
    expect(v.blob.loop).toBe(v.blob); // cycle re-anchored to the same object after the round-trip

    client[Symbol.dispose]();
  });

  it('rich types survive the subscribe/fanout path to a second client', async () => {
    const star = uniqueStar();
    const a = await setupAdminClient(star);
    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const resourceId = generateUuid();

    await a.client.resources.transaction({
      [resourceId]: {
        op: 'create', typeName: 'RichResource', nodeId: ROOT_NODE_ID,
        value: { label: 'fan', when: new Date('2026-05-06T00:00:00.000Z'), counts: new Map([['k', 9]]), tags: new Set(['t']) },
      },
    });

    // B receives the snapshot over the fanout/subscribe path (handleResourceUpdate),
    // a different wire write-through than read() — assert it preserves types too.
    const sub = b.client.resources.subscribe('RichResource', resourceId);
    const snap = await sub.snapshot;
    const v = snap!.value as { when: Date; counts: Map<string, number>; tags: Set<string> };
    expect(v.when).toBeInstanceOf(Date);
    expect(v.counts).toBeInstanceOf(Map);
    expect(v.counts.get('k')).toBe(9);
    expect(v.tags).toBeInstanceOf(Set);

    sub[Symbol.dispose]();
    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });
});
