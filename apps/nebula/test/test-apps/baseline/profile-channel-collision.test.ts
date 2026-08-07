/**
 * Profile channel — the BLOCKER + shipped-bug fix (tasks/nebula-subscriber-lists.md).
 *
 * The platform profile rides a DEDICATED client channel (`#profileRefcount` / `handleProfileUpdate`), so it
 * never shares the resource `${type}:${id}` keyspace/routing with a dev-user ontology type named `Profile`
 * (Decision 2 keeps such a type LEGAL). This test proves a dev-user `Profile`-typed RESOURCE reconnects to
 * its STAR — NOT the global PROFILE DO — closing the shipped `#resubscribeAll` mis-route (nebula-client.ts,
 * committed `2a2978b`) that routed any `resourceType === 'Profile'` entry to the PROFILE binding and would
 * silently lose that resource's updates after any WS blip.
 *
 * Auth: **real server issuance** (ADR-009 rung 2) via `adminClientAt` — claim the universe, which mints the
 * universe admin `scopeAdmin: true`, then refresh at the star — so the client can install an ontology with a `Profile`
 * type + create/subscribe a resource of it. No hand-minted token: nothing here needs an identity shape real
 * issuance can't produce.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult } from '@lumenize/nebula';
import { NebulaClientTest } from './index';
import { adminClientAt } from '../../test-helpers';

const ORIGIN = 'http://localhost';
function uuid(): string { return crypto.randomUUID(); }
function uniqueStar(): string { return `acme-${uuid().slice(0, 8)}.app.tenant`; }

/**
 * A connected ADMIN `NebulaClientTest` for `star` (can applyOntology + create), via **real server
 * issuance** — claim the universe (which mints the universe admin, `scopeAdmin: true`), consume the magic
 * link, refresh at the star. Rung 2 of the ADR-009 ladder, and rung 3 is gone from this file.
 *
 * This used to hand-mint a token, justified in-place as *"browserLogin is red mid-turnover"*. That
 * excuse expired: `adminClientAt` works, and nothing here needs a shape real issuance can't produce
 * — it wants an admin at a star, which the universe admin's pattern already covers. (Its siblings
 * `profile-do` / `profile-subscribe` / `subscriber-list` legitimately keep the mint; they assert on
 * `profileId`/`sub` values they must choose. See their headers.)
 */
async function adminClient(star: string): Promise<NebulaClientTest> {
  const browser = new Browser();
  const { client } = await adminClientAt(NebulaClientTest, browser, star, star, 'admin@example.com');
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

async function waitDone(c: NebulaClientTest): Promise<void> {
  await vi.waitFor(() => expect(c.callCompleted).toBe(true));
}

/** Count STAR `Subscribers` rows for `resourceId` (PK `(resourceId, clientId)`). */
async function starSubRows(star: string, resourceId: string): Promise<number> {
  const stub: any = (env as any).STAR.getByName(star);
  return (runInDurableObject as any)(stub, (_i: any, c: any) =>
    (c.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscribers WHERE resourceId = ?', resourceId)
      .toArray()[0].n as number));
}

describe('Profile channel — a dev-user `Profile` type does NOT collide with the platform profile', () => {
  it('a dev-user `Profile` RESOURCE reconnects to its STAR, not the global PROFILE DO (BLOCKER + shipped-bug fix)', async () => {
    const star = uniqueStar();
    const client = await adminClient(star);

    // Install an ontology whose type is literally named `Profile` (Decision 2 keeps this LEGAL).
    client.callStarApplyOntology(star, { version: 'v1', types: `interface Profile { name: string; }` });
    await waitDone(client);

    // Create + subscribe a resource OF that dev-user `Profile` type.
    const rid = uuid();
    await client.callStarTransaction(star, 'v1', {
      [rid]: { op: 'create', typeName: 'Profile', nodeId: ROOT_NODE_ID, value: { name: 'dev-user resource' } },
    });
    expect((client.lastResult as TransactionResult)?.ok).toBe(true);
    await client.resources.subscribe('Profile', rid).snapshot;
    await vi.waitFor(async () => expect(await starSubRows(star, rid)).toBe(1)); // subscribed on the STAR

    // Drop the STAR row so ONLY a correct reconnect re-subscribe can restore it.
    const stub: any = (env as any).STAR.getByName(star);
    await (runInDurableObject as any)(stub, (_i: any, c: any) =>
      c.storage.sql.exec('DELETE FROM Subscribers WHERE resourceId = ?', rid));
    expect(await starSubRows(star, rid)).toBe(0);

    // The reconnect walk MUST re-fire `Star.subscribe(v, 'Profile', rid)` to the STAR. The shipped bug
    // routed any `resourceType === 'Profile'` entry to the global PROFILE DO instead — which would leave
    // the STAR row absent (silently losing this resource's updates).
    (client as any)._resubscribeAllForTest();
    await vi.waitFor(async () => expect(await starSubRows(star, rid)).toBe(1));
  });
});
