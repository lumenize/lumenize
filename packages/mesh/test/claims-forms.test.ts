import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import type { CallEnvelope } from '../src/lmz-api';

/**
 * Running a block under claims: `lmz.actFor` (a node acts for a person under a stored record),
 * and `lmz.asLocalPrincipal` (a node's local principal acts as itself).
 *
 * These run in Mesh's own lane, on real Durable Objects, where a record of any shape can be
 * handed in: a refusal of a record no product path writes has no other caller. `apps/nebula`'s
 * `waiting-posts.test.ts` drives `actFor` through the Galaxy, under records the server stamped.
 * A call that carries claims is sent the way a Client's host node sends one, as an envelope whose
 * `callContext.originAuth` is filled in.
 */

const PERSON = { sub: 'person-1', profileId: 'profile-1', aud: 'acme.crm', access: { authScope: 'acme', scopeAdmin: true } };
const PRINCIPAL = 'agent:test';

/** A call to `method` on TEST_DO `instance`, carrying `claims` as a Client's host node would stamp them. */
function callWithClaims(instance: string, method: string, args: unknown[], claims: Record<string, unknown>): CallEnvelope {
  const client = { type: 'LumenizeClient' as const, bindingName: 'TEST_DO', instanceName: `${instance}/person-1.tab` };
  return {
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
    callContext: {
      callChain: [client],
      originAuth: { sub: claims.sub as string, claims },
      originRequest: { origin: 'https://crm.acme.example', ip: '203.0.113.7' },
    },
    metadata: { caller: client, callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: instance } },
  };
}

/** Send a claims-carrying call and read the outcome `tryClaimsForm` kept for `which`. */
async function refusalOf(instance: string, which: string): Promise<string> {
  const node = env.TEST_DO.getByName(instance);
  expect(await node.__executeOperation(callWithClaims(instance, 'tryClaimsForm', [which], PERSON))).toEqual({ $ack: true });
  return vi.waitFor(async () => {
    const outcome = await node.readKv(`claims_form_${which}`);
    expect(outcome).toBeDefined();
    return outcome as string;
  });
}

describe('lmz.actFor — an object that is no record', () => {
  // A node cannot pass off a running call's claims as a record: the object has no `sub` of its
  // own. Mutation: read `originAuth` off the argument → it runs.
  it('refuses an object that only carries a call\'s claims', async () => {
    expect(await refusalOf('act_for_forged_1', 'forged')).toMatch(/not shaped like a person's id/);
  });
});

/**
 * The person in the record is never the caller of the probe: the probe's call
 * carries PERSON's claims, with another `sub`, scope and admin bit, so a build that re-used the
 * call it runs in would show PERSON's and fail every case here.
 */
const WRITER = '7c1e2f3a-4b5c-4d6e-8f70-112233445566';
const RECORD = { sub: WRITER, profileId: 'b0d4a1c2-0000-4000-8000-000000000001', aud: 'beta.shop', access: { authScope: 'beta.shop' } };

/** Send PERSON's call to `actForRecord` on `actor`, and read what the block and the second node saw. */
async function actUnder(tag: string, record: Record<string, unknown>, dominionOver = 'beta.shop') {
  const actor = env.TEST_DO.getByName(`record_actor_${tag}`);
  const second = env.TEST_DO.getByName(`record_second_${tag}`);
  expect(await actor.__executeOperation(callWithClaims(
    `record_actor_${tag}`, 'actForRecord', [record, PRINCIPAL, 'TEST_DO', `record_second_${tag}`, dominionOver], PERSON,
  ))).toEqual({ $ack: true });
  const seen = await vi.waitFor(async () => {
    const c = await second.getObservedContext();
    expect(c).toBeDefined();
    return c;
  });
  return { actor, seen, inNode: await actor.readKv('record_context'), dominion: await actor.readKv('record_dominion') };
}

async function recordRefusal(tag: string, record: Record<string, unknown>, principal = PRINCIPAL): Promise<string> {
  const node = env.TEST_DO.getByName(`record_refusal_${tag}`);
  expect(await node.__executeOperation(callWithClaims(`record_refusal_${tag}`, 'tryRecordForm', [tag, record, principal], PERSON))).toEqual({ $ack: true });
  return vi.waitFor(async () => {
    const outcome = await node.readKv(`record_form_${tag}`);
    expect(outcome).toBeDefined();
    return outcome as string;
  });
}

describe('lmz.actFor — a node acts under a stored record', () => {
  // MUTATIONS: run under the record unchanged (drop the `act` line), and `act` is missing; build
  // from the call the probe runs in, and the subject, scope and admin bit are PERSON's.
  it('runs under the record\'s subject, scope and access, with the principal as actor', async () => {
    const { seen, inNode } = await actUnder('plain', RECORD);
    for (const context of [inNode, seen]) {
      expect(context.originAuth.sub).toBe(WRITER);
      expect(context.originAuth.claims).toEqual({ ...RECORD, act: { sub: PRINCIPAL, profileId: PRINCIPAL } });
    }
    // A fresh chain the acting node starts.
    expect(seen.callChain).toHaveLength(1);
    expect(seen.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'record_actor_plain' });
  });

  // MUTATION: pass `undefined` as `prependActor`'s base, and the coach vanishes from both nodes.
  it('keeps the actor a record already has beneath the principal', async () => {
    const coach = { sub: 'c0ac4000-0000-4000-8000-000000000002', profileId: 'c0ac4000-0000-4000-8000-000000000003' };
    const { seen, inNode } = await actUnder('impersonated', { ...RECORD, act: coach });
    for (const context of [inNode, seen]) {
      expect(context.originAuth.claims.act).toEqual({ sub: PRINCIPAL, profileId: PRINCIPAL, act: coach });
    }
  });

  // MUTATION: drop `access` when building the claims, and the admin's record holds no dominion.
  it('carries the record\'s admin bit, and none where the record has none', async () => {
    const admin = await actUnder('admin', { ...RECORD, access: { authScope: 'beta.shop', scopeAdmin: true } });
    expect(admin.dominion).toBe(true);
    const member = await actUnder('member', RECORD);
    expect(member.dominion).toBe(false);
  });

  // MUTATION: never set `originRequest`, and the callee sees none.
  it('hands the chain the node\'s own origin when it has one, and none otherwise', async () => {
    const origin = 'http://shop.beta.lumenize.localhost:5174';
    await env.TEST_DO.getByName('record_actor_origin').setTestOrigin(origin);
    const withOrigin = await actUnder('origin', RECORD);
    expect(withOrigin.inNode.originRequest).toEqual({ origin });
    expect(withOrigin.seen.originRequest).toEqual({ origin });
    // PERSON's own call arrived with an origin of its own, which the block does not inherit.
    const without = await actUnder('no_origin', RECORD);
    expect(without.inNode.originRequest).toBeUndefined();
    expect(without.seen.originRequest).toBeUndefined();
  });

  // MUTATION: drop the shape check on `sub`, and a local principal's own record runs.
  it('refuses a record a local principal wrote as itself', async () => {
    expect(await recordRefusal('own', { sub: PRINCIPAL, profileId: PRINCIPAL, aud: 'beta.shop', access: { authScope: 'beta.shop' } }))
      .toMatch(/not shaped like a person's id/);
  });

  // MUTATION: drop the check on the outermost actor, and the principal is prepended twice.
  it('refuses a record the principal already acts in', async () => {
    expect(await recordRefusal('twice', { ...RECORD, act: { sub: PRINCIPAL, profileId: PRINCIPAL } }))
      .toMatch(/already its outermost actor/);
  });

  // MUTATION: skip the name check on the principal, and it runs.
  it('refuses a principal named like a person', async () => {
    expect(await recordRefusal('uuid', RECORD, crypto.randomUUID())).toMatch(/shaped like a person's id/);
  });
});

describe('lmz.asLocalPrincipal — a local principal acts as itself', () => {
  // Mutation: give the built claims `scopeAdmin: true` → the dominion bypass passes at the node's
  // own name → `local_principal_dominion` is true → this reds.
  it('builds claims from the node name, with no scopeAdmin, so the dominion bypass never fires', async () => {
    const node = env.TEST_DO.getByName('local_principal_1');
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'local_principal_1' });
    await node.runAsLocalPrincipal(PRINCIPAL, 'TEST_DO', 'local_principal_callee_1');

    // The dominion check first, so the mutation above is caught by the verdict and not only by shape.
    expect(await node.readKv('local_principal_dominion')).toBe(false);
    const built = await node.readKv('local_principal_context');
    expect(built.originAuth).toEqual({
      sub: PRINCIPAL,
      claims: { sub: PRINCIPAL, profileId: PRINCIPAL, aud: 'local_principal_1', access: { authScope: 'local_principal_1' } },
    });
  });

  // Mutation: let `buildOutgoingCallContext` inherit a local principal's context (drop the
  // `local-principal` arm) → the callee reads `agent:test` as its caller → this reds.
  it('a call made inside starts a fresh chain with no claims', async () => {
    const node = env.TEST_DO.getByName('local_principal_2');
    const callee = env.TEST_DO.getByName('local_principal_callee_2');
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'local_principal_2' });
    await node.runAsLocalPrincipal(PRINCIPAL, 'TEST_DO', 'local_principal_callee_2');

    const seen = await vi.waitFor(async () => {
      const c = await callee.getObservedContext();
      expect(c).toBeDefined();
      return c;
    });
    expect(seen.originAuth).toBeUndefined();
    expect(seen.callChain).toHaveLength(1);
    expect(seen.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'local_principal_2' });
  });

  // Mutation: skip the name check in `asLocalPrincipalShared` → 'ran'.
  it('refuses a name shaped like a UUID', async () => {
    expect(await refusalOf('local_principal_uuid_1', 'uuid-principal')).toMatch(/shaped like a person's id/);
  });
});
