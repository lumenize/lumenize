/**
 * Node invites — `Star.invite(nodeId, invitees)` writes BOTH planes at invite time: the DAG grant
 * here (via the traveling result handler) and the membership through the facade → Registry. The
 * invitee's first login finds everything in place; the live submission state rides `_InviteStatus`
 * rows (a platform-fixed Resources type, org-visible at the node per ADR-008).
 *
 * ADR-009 rung 2 (the whole baseline lane): real founding, real invites, real server-issued
 * logins. Every persisted effect is asserted through a real login or the running data plane —
 * never the ack alone. The `/live` twin (`harness/scenarios/node-invite-roundtrip.ts`) walks the
 * same flow on real email.
 *
 * ⚠️ A runtime precondition every test here honors: the node invite's `_InviteStatus` writes ride
 * the ordinary Resources pipeline, so the host Star must hold an INSTALLED ontology (true of every
 * resource write; a production Star always has its app's). `callStarApplyOntology` installs one.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Star, NodeInviteAck, NebulaClient } from '@lumenize/nebula';
import {
  adminClientAt, createPlatformAdminClient, createInvitedClient, createSubject, browserLogin,
  uniqueStar,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = 'interface TestResource { title: string }';

function em(tag: string): string { return `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`; }

/** The `callAsync` path a production caller uses (the eventual UI affordance is app code). */
function nodeInvite(client: NebulaClient, nodeId: string, invitees: unknown): Promise<NodeInviteAck> {
  return client.lmz.callAsync(
    'STAR', client.claims.aud,
    client.ctn<Star>().invite(nodeId, invitees as any),
  );
}

/** Admin at `star` with the test ontology installed (_InviteStatus rides any version — it is
 *  platform-unioned into every compiled ontology). */
async function starWithOntology(star: string) {
  const browser = new Browser();
  const admin = await adminClientAt(NebulaClientTest, browser, star, star, em('adm'));
  admin.client.callStarApplyOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await vi.waitFor(() => { expect(admin.client.callCompleted).toBe(true); });
  return { browser, ...admin };
}

/** The current _InviteStatus rows at `nodeId`, as { email → { state, tier, error? } } — read
 *  through the PUBLIC query + read path (what the members panel does). */
async function inviteStatuses(
  client: NebulaClient, nodeId: string,
): Promise<Record<string, { state: string; tier: string; error?: string }>> {
  using sub = client.resources.subscribeQuery({
    queryType: 'parentChild', typeName: '_InviteStatus', field: 'node', value: nodeId,
  });
  await sub.ready;
  const out: Record<string, { state: string; tier: string; error?: string }> = {};
  for (const id of sub.resourceIds) {
    const snapshot = await client.resources.read('_InviteStatus', id);
    if (snapshot) {
      const v = snapshot.value as { email: string; state: string; tier: string; error?: string };
      out[v.email] = { state: v.state, tier: v.tier, ...(v.error !== undefined ? { error: v.error } : {}) };
    }
  }
  return out;
}

describe('PLATFORM_RESOURCE_TYPES — the reserved "_" namespace refuses loudly', () => {
  it('an app ontology declaring any _-prefixed type name is refused at compile, never merged', async () => {
    // Pure function, no running system needed: the guard exists because TypeScript would MERGE a
    // duplicate interface silently (declaration merging), and the validator compiler emits despite
    // type errors — so without the explicit check a colliding app type widens the platform type
    // with no signal anywhere. The PREFIX is reserved wholesale, not the current names — hence the
    // second probe, a name on no platform list, which proves the rule is the namespace and a
    // future platform type needs no guard edit. Reds against deleting the underscore check in
    // compileOntologyVersion (the compile then succeeds — the silent merge).
    const { compileOntologyVersion } = await import('../../../src/ontology-compile');
    for (const name of ['_InviteStatus', '_AnyFutureName']) {
      expect(() => compileOntologyVersion({
        version: 'v-collide', types: `interface ${name} { anything: string }`,
      })).toThrow(new RegExp(`"${name}" starts with "_"`));
    }
    // Positive control: a non-colliding config still compiles (the guard refuses names, not apps).
    expect(compileOntologyVersion({ version: 'v-ok', types: TEST_TYPES }).version).toBe('v-ok');
  });
});

describe('Star.invite — scenario 5 end to end', () => {
  it('writes the grant at invite time; the invitee\'s first login resolves the permission with nothing left to apply', async () => {
    const star = uniqueStar();
    const { client: admin } = await starWithOntology(star);
    const invitee = em('node-invitee');
    try {
      const ack = await nodeInvite(admin, ROOT_NODE_ID, [{ email: invitee, tier: 'write' }]);
      expect(ack).toEqual({ accepted: 1, errors: [] });

      // The handler's flip to `sent` is the observable "both planes written" moment.
      await vi.waitFor(async () => {
        const statuses = await inviteStatuses(admin, ROOT_NODE_ID);
        expect(statuses[invitee]?.state).toBe('sent');
      });

      // The invitee's FIRST login (the membership the facade minted admits them), then a WRITE at
      // the node — the grant written at invite time is what authorizes it, with nothing left to
      // apply. Reds on PermissionDeniedError when the grant write is skipped.
      const inviteeSession = await createInvitedClient(NebulaClientTest, new Browser(), star, star, invitee);
      try {
        expect(inviteeSession.payload.access.scopeAdmin).toBeUndefined(); // the node path mints no admin
        const outcome = await inviteeSession.client.resources.transaction({
          [crypto.randomUUID()]: {
            op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID,
            value: { title: 'written under the invite-time grant' },
          },
        });
        expect(outcome.kind).toBe('committed');
      } finally {
        inviteeSession.client.disconnect();
      }
    } finally {
      admin.disconnect();
    }
  });

  it('an already-member node invite writes the MISSING grant (the one reachable two-plane inconsistency heals)', async () => {
    const star = uniqueStar();
    const { browser, client: admin, accessToken } = await starWithOntology(star);
    const member = em('member-no-grant');
    try {
      // The honest fixture: a DIRECT scope invite mints the membership — no DAG grant anywhere.
      // (An expired-token-then-re-invite fixture cannot red this: expiry preserves a first node
      // invite's grant, so permission resolves either way.)
      await createSubject(browser, star, accessToken, member);
      const preGrant = await createInvitedClient(NebulaClientTest, new Browser(), star, star, member);
      try {
        const denied = await preGrant.client.resources.transaction({
          [crypto.randomUUID()]: {
            op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'x' },
          },
        });
        expect(denied.kind).toBe('rejected'); // fixture guard: membership exists, grant does not

        // Node-invite the SAME address: the summary outcome is `already-member`, and the grant is
        // still written — reds against skipping the grant for already-member outcomes.
        const ack = await nodeInvite(admin, ROOT_NODE_ID, [{ email: member, tier: 'write' }]);
        expect(ack.accepted).toBe(1);
        await vi.waitFor(async () => {
          const outcome = await preGrant.client.resources.transaction({
            [crypto.randomUUID()]: {
              op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID,
              value: { title: 'healed' },
            },
          });
          expect(outcome.kind).toBe('committed');
        });
      } finally {
        preGrant.client.disconnect();
      }
    } finally {
      admin.disconnect();
    }
  });
});

describe('Star.invite — the validation boundary', () => {
  it('a malformed email joins the per-invitee errors without failing the batch', async () => {
    const star = uniqueStar();
    const { client: admin } = await starWithOntology(star);
    const good = em('good');
    try {
      const ack = await nodeInvite(admin, ROOT_NODE_ID, [
        { email: good, tier: 'read' },
        { email: 'not-an-email', tier: 'read' },
        42,
      ]);
      expect(ack.accepted).toBe(1);
      expect(ack.errors).toHaveLength(2);
      expect(ack.errors[0].error).toBe('Invalid email format');
    } finally {
      admin.disconnect();
    }
  });

  it('an out-of-vocabulary tier is refused BEFORE any mint or send side effect, distinguishably from the DAG refusal', async () => {
    const star = uniqueStar();
    const { client: admin } = await starWithOntology(star);
    const victim = em('never-minted');
    try {
      await expect(nodeInvite(admin, ROOT_NODE_ID, [{ email: victim, tier: 'owner' }]))
        .rejects.toThrow('Invalid node invite: tier "owner" is not one of admin | write | read');

      // BEFORE any side effect: no pending row was written for the refused batch…
      const statuses = await inviteStatuses(admin, ROOT_NODE_ID);
      expect(statuses[victim]).toBeUndefined();
      // …and the positive control: the SAME entry with a legal tier goes all the way through, so
      // the refusal above was the tier gate, not a broken path.
      const probe = await nodeInvite(admin, ROOT_NODE_ID, [{ email: victim, tier: 'read' }]);
      expect(probe.accepted).toBe(1);
      await vi.waitFor(async () => {
        expect((await inviteStatuses(admin, ROOT_NODE_ID))[victim]?.state).toBe('sent');
      });
    } finally {
      admin.disconnect();
    }
  });

  it('a caller without admin at the node is refused with the DAG refusal, distinguishable from a facade refusal', async () => {
    const star = uniqueStar();
    const { browser, client: admin, accessToken } = await starWithOntology(star);
    const memberEmail = em('plain-member');
    try {
      await createSubject(browser, star, accessToken, memberEmail);
      const member = await createInvitedClient(NebulaClientTest, new Browser(), star, star, memberEmail);
      try {
        // A member with no DAG grant: `requirePermission(nodeId, 'admin')` refuses with ITS
        // message — never a facade wording (mutation: collapse the messages → reds).
        await expect(nodeInvite(member.client, ROOT_NODE_ID, [{ email: em('x'), tier: 'read' }]))
          .rejects.toThrow(`admin permission required on node ${ROOT_NODE_ID}`);
      } finally {
        member.client.disconnect();
      }
    } finally {
      admin.disconnect();
    }
  });
});

describe('_InviteStatus — org-visible live state', () => {
  it('a second admin\'s re-invite converges on ONE row, in a defined state', async () => {
    const star = uniqueStar();
    const { client: adminA } = await starWithOntology(star);
    // A SECOND admin over the node: the platform bootstrap admin — the one production path to a
    // second scope-admin here (the universe admin IS the star founder's own identity), and its
    // dominion covers the node via the root scope.
    const { client: adminB } = await createPlatformAdminClient(NebulaClientTest, new Browser(), star);
    const target = em('twice-invited');
    try {
      await nodeInvite(adminA, ROOT_NODE_ID, [{ email: target, tier: 'read' }]);
      await vi.waitFor(async () => {
        expect((await inviteStatuses(adminA, ROOT_NODE_ID))[target]?.state).toBe('sent');
      });

      await nodeInvite(adminB, ROOT_NODE_ID, [{ email: target, tier: 'write' }]);
      await vi.waitFor(async () => {
        const statuses = await inviteStatuses(adminB, ROOT_NODE_ID);
        expect(statuses[target]?.state).toBe('sent');
        expect(statuses[target]?.tier).toBe('write'); // the re-invite's tier won the converged row
      });

      // Exactly ONE row for the address — reds against INSERTing a second (the convergence rule).
      using sub = adminB.resources.subscribeQuery({
        queryType: 'parentChild', typeName: '_InviteStatus', field: 'node', value: ROOT_NODE_ID,
      });
      await sub.ready;
      let matches = 0;
      for (const id of sub.resourceIds) {
        const snapshot = await adminB.resources.read('_InviteStatus', id);
        if ((snapshot?.value as { email?: string } | undefined)?.email === target) matches++;
      }
      expect(matches).toBe(1);
    } finally {
      adminA.disconnect();
      adminB.disconnect();
    }
  });

  it('pending → sent arrives via subscription to a SECOND admin, and the rows survive the inviter\'s disconnect', async () => {
    const star = uniqueStar();
    const { client: adminA } = await starWithOntology(star);
    const { client: adminB } = await createPlatformAdminClient(NebulaClientTest, new Browser(), star);
    const invitee = em('watched');
    try {
      // B subscribes FIRST (org-visible, ADR-008): the whole lifecycle arrives on B's channel.
      using sub = adminB.resources.subscribeQuery({
        queryType: 'parentChild', typeName: '_InviteStatus', field: 'node', value: ROOT_NODE_ID,
      });
      await sub.ready;

      await nodeInvite(adminA, ROOT_NODE_ID, [{ email: invitee, tier: 'read' }]);
      // Membership push reaches B…
      await vi.waitFor(() => { expect(sub.resourceIds.length).toBeGreaterThan(0); });
      // …and the row reaches `sent` (reds against never flipping from `pending`).
      await vi.waitFor(async () => {
        expect((await inviteStatuses(adminB, ROOT_NODE_ID))[invitee]?.state).toBe('sent');
      });

      // The rows are DO state, not session state: the INVITER disconnecting loses nothing.
      adminA.disconnect();
      expect((await inviteStatuses(adminB, ROOT_NODE_ID))[invitee]?.state).toBe('sent');
    } finally {
      adminB.disconnect();
    }
  });
});
