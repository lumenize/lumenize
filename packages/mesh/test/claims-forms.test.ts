import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import type { CallEnvelope } from '../src/lmz-api';
import { prependActor } from '../src/auth/access-claims';

/**
 * Running a block under claims: `lmz.holdCall` + `lmz.actFor` (a node acts for a caller it holds),
 * and `lmz.asLocalPrincipal` (a node's local principal acts as itself).
 *
 * These run in Mesh's own lane, on real Durable Objects, because no product path reaches the two
 * forms yet: the agent loop that uses them is built on top. A call that carries claims is sent the
 * way a Client's host node sends one, as an envelope whose `callContext.originAuth` is filled in.
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

describe('lmz.actFor — a node acts for a caller it holds', () => {
  // Mutation: start the chain with the held claims unchanged (drop the `act` line in
  // `actForShared`) → `act` is missing on both nodes → this reds.
  it('the second node records the held caller as subject and the local principal as actor', async () => {
    const actor = env.TEST_DO.getByName('act_for_actor_1');
    const second = env.TEST_DO.getByName('act_for_second_1');
    expect(await actor.__executeOperation(
      callWithClaims('act_for_actor_1', 'holdThenActFor', [PRINCIPAL, 'TEST_DO', 'act_for_second_1'], PERSON),
    )).toEqual({ $ack: true });

    const seen = await vi.waitFor(async () => {
      const c = await second.getObservedContext();
      expect(c).toBeDefined();
      return c;
    });
    expect(seen.originAuth.sub).toBe('person-1');
    expect(seen.originAuth.claims.act).toEqual({ sub: PRINCIPAL, profileId: PRINCIPAL });
    // Everything authorization reads is the caller's own, untouched.
    expect(seen.originAuth.claims.aud).toBe('acme.crm');
    expect(seen.originAuth.claims.access).toEqual({ authScope: 'acme', scopeAdmin: true });
    // A fresh chain: the acting node is its origin, and the caller's request facts ride on.
    expect(seen.callChain).toHaveLength(1);
    expect(seen.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'act_for_actor_1' });
    expect(seen.originRequest).toEqual({ origin: 'https://crm.acme.example', ip: '203.0.113.7' });

    // In-node code inside the block reads the same claims, so an in-node write records both too.
    const inNode = await actor.readKv('acted_context');
    expect(inNode.originAuth.claims.act).toEqual({ sub: PRINCIPAL, profileId: PRINCIPAL });
    // The exact shape the impersonation mint is tested against (auth/impersonation-mint.test.ts).
    expect(inNode.originAuth.claims).toEqual({ ...PERSON, act: prependActor(undefined, { sub: PRINCIPAL, profileId: PRINCIPAL }) });
  });

  // Mutation: build the new `act` without the held chain (pass `undefined` as `prependActor`'s
  // base) → the coach vanishes from the record → this reds.
  it("keeps an impersonated caller's own actor beneath the local principal", async () => {
    const actor = env.TEST_DO.getByName('act_for_actor_2');
    const second = env.TEST_DO.getByName('act_for_second_2');
    const impersonated = { ...PERSON, act: { sub: 'coach-1', profileId: 'coach-profile' } };
    expect(await actor.__executeOperation(
      callWithClaims('act_for_actor_2', 'holdThenActFor', [PRINCIPAL, 'TEST_DO', 'act_for_second_2'], impersonated),
    )).toEqual({ $ack: true });

    const seen = await vi.waitFor(async () => {
      const c = await second.getObservedContext();
      expect(c).toBeDefined();
      return c;
    });
    expect(seen.originAuth.claims.act).toEqual({
      sub: PRINCIPAL, profileId: PRINCIPAL, act: { sub: 'coach-1', profileId: 'coach-profile' },
    });
  });

  // The marker that stops a node re-chaining its own re-chained call is a symbol, which no wire
  // carries, so the next node sees an ordinary call and may act for it in its own right. Mutation:
  // key the marker with a string → it rides the envelope → the second node refuses to hold.
  it('lets the next node hold a call that arrived already acted for', async () => {
    const actor = env.TEST_DO.getByName('act_for_actor_3');
    const second = env.TEST_DO.getByName('act_for_second_3');
    expect(await actor.__executeOperation(callWithClaims(
      'act_for_actor_3', 'holdThenActFor', [PRINCIPAL, 'TEST_DO', 'act_for_second_3', 'tryClaimsForm', ['hold']], PERSON,
    ))).toEqual({ $ack: true });
    const outcome = await vi.waitFor(async () => {
      const o = await second.readKv('claims_form_hold');
      expect(o).toBeDefined();
      return o as string;
    });
    expect(outcome).toBe('ran');
  });

  // Mutation: accept any object carrying `originAuth` (read it off the argument instead of the
  // registry of genuine handles) → the forged handle runs → this reads 'ran'.
  it('refuses a handle the node built itself', async () => {
    expect(await refusalOf('act_for_forged_1', 'forged')).toMatch(/Not a held call/);
  });

  // Mutation: drop the `local-principal` refusal in `holdCallShared` → the handle holds the
  // principal's own claims, which could then leave the node → this reads 'ran'.
  it("refuses to hold a local principal's own claims", async () => {
    expect(await refusalOf('act_for_in_lp_1', 'hold-in-local-principal')).toMatch(/local principal's own claims/);
  });

  // Mutation: drop the `rechained` refusal → the principal could be prepended twice → 'ran'.
  it('refuses to hold a call already acted for', async () => {
    expect(await refusalOf('act_for_in_acted_1', 'hold-in-acted')).toMatch(/already acted for/);
  });

  // Mutation: return a handle when no call is running → this reads 'ran'.
  it('refuses to hold when no call is running', async () => {
    const node = env.TEST_DO.getByName('act_for_outside_1');
    expect(await node.tryHoldOutsideCall()).toMatch(/outside of a mesh call/);
  });

  // A chain a node started carries no claims, so there is no caller to act for. Mutation: drop the
  // `originAuth` check in `holdCallShared` → the handle holds nothing, and this reads 'ran'.
  it('refuses to hold a call that carries no claims', async () => {
    const caller = env.TEST_DO.getByName('act_for_noclaims_caller_1');
    const node = env.TEST_DO.getByName('act_for_noclaims_1');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'act_for_noclaims_caller_1' });
    caller.fireCall('TEST_DO', 'act_for_noclaims_1', 'tryClaimsForm', ['hold']);
    const outcome = await vi.waitFor(async () => {
      const o = await node.readKv('claims_form_hold');
      expect(o).toBeDefined();
      return o as string;
    });
    expect(outcome).toMatch(/carries no claims/);
  });

  // Mutation: skip the name check in `actForShared` → 'ran'.
  it('refuses an actor named like a person', async () => {
    expect(await refusalOf('act_for_uuid_1', 'uuid-actor')).toMatch(/shaped like a person's id/);
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
