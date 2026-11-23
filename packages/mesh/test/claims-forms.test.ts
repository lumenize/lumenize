import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import type { CallEnvelope } from '../src/lmz-api';
import { rawRpcStub } from '../src/raw-rpc';
import { isPersonSub } from '../src/auth/types';

/**
 * Running a block under claims: `lmz.actFor` (a node acts for a person under a stored record),
 * `lmz.asAgentPrincipal` (a node's agent principal acts as itself), and `lmz.asSystemPrincipal`
 * (a scoped node acts as its own system principal).
 *
 * These run in Mesh's own lane, on real Durable Objects, where a record of any shape can be
 * handed in: a refusal of a record no product path writes has no other caller. `apps/nebula`'s
 * `waiting-posts.test.ts` drives `actFor` through the Galaxy, under records the server stamped.
 * A call that carries claims is sent the way a Client's host node sends one, as an envelope whose
 * `callContext.originAuth` is filled in.
 *
 * The system principal's cases are here because they are about what Mesh builds from a node's
 * name alone, for any scoped node, and its refusals name kinds of node no product path runs it
 * on; `apps/nebula`'s `galaxy-builds-its-tree` scenario reads it on the running Galaxy.
 * `isPersonSub` is a pure predicate over a string, so it needs no running system.
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
  // own. Mutation: drop the shape check on `sub` → it runs.
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

  // MUTATION: drop the shape check on `sub`, and an agent principal's own record runs.
  it('refuses a record an agent principal wrote as itself', async () => {
    expect(await recordRefusal('own', { sub: PRINCIPAL, profileId: PRINCIPAL, aud: 'beta.shop', access: { authScope: 'beta.shop' } }))
      .toMatch(/not shaped like a person's id/);
  });

  // MUTATION: skip the name check on the principal, and it runs.
  it('refuses a principal named like a person', async () => {
    expect(await recordRefusal('uuid', RECORD, crypto.randomUUID())).toMatch(/takes the form "agent:name"/);
  });
});

describe('lmz.asAgentPrincipal — an agent principal acts as itself', () => {
  // Mutation: give the built claims `scopeAdmin: true` → the dominion bypass passes at the node's
  // own name → `agent_principal_dominion` is true → this reds.
  it('builds claims from the node name, with no scopeAdmin, so the dominion bypass never fires', async () => {
    const node = env.TEST_DO.getByName('agent_principal_1');
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'agent_principal_1' });
    await node.runAsAgentPrincipal(PRINCIPAL, 'TEST_DO', 'agent_principal_callee_1');

    // The dominion check first, so the mutation above is caught by the verdict and not only by shape.
    expect(await node.readKv('agent_principal_dominion')).toBe(false);
    const built = await node.readKv('agent_principal_context');
    expect(built.originAuth).toEqual({
      sub: PRINCIPAL,
      claims: { sub: PRINCIPAL, profileId: PRINCIPAL, aud: 'agent_principal_1', access: { authScope: 'agent_principal_1' } },
    });
  });

  // Mutation: let `buildOutgoingCallContext` inherit an agent principal's context (drop the
  // kind arm) → the callee reads `agent:test` as its caller → this reds.
  it('a call made inside starts a fresh chain with no claims', async () => {
    const node = env.TEST_DO.getByName('agent_principal_2');
    const callee = env.TEST_DO.getByName('agent_principal_callee_2');
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'agent_principal_2' });
    await node.runAsAgentPrincipal(PRINCIPAL, 'TEST_DO', 'agent_principal_callee_2');

    const seen = await vi.waitFor(async () => {
      const c = await callee.getObservedContext();
      expect(c).toBeDefined();
      return c;
    });
    expect(seen.originAuth).toBeUndefined();
    expect(seen.callChain).toHaveLength(1);
    expect(seen.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'agent_principal_2' });
  });

  // Mutations: skip the name check in `asAgentPrincipalShared`, and every row runs. Accept any
  // `kind:name`, and the `system:` and `webhook:` rows run.
  it.each([
    ['a node\'s own system principal', 'system:acme.crm'],
    ['another kind of principal', 'webhook:stripe'],
    ['a name with no prefix', 'lumenize'],
    ['the prefix with no name', 'agent:'],
    ['the empty string', ''],
    ['a person\'s id', '7c1e2f3a-4b5c-4d6e-8f70-112233445566'],
  ])('refuses %s as an agent principal', async (_what, principal) => {
    const outcome = await env.TEST_DO.getByName('agent_principal_names').tryAgentPrincipalName(principal);
    expect(outcome).toMatch(/takes the form "agent:name"/);
    expect(outcome).toContain(JSON.stringify(principal));
  });

  it('runs a block for a sub of the form agent:name', async () => {
    expect(await env.TEST_DO.getByName('agent_principal_names').tryAgentPrincipalName('agent:lumenize')).toBe('ran');
  });
});

describe('lmz.asSystemPrincipal — a scoped node acts as itself', () => {
  const SYSTEM = 'system:acme.crm';

  // Mutations: drop `scopeAdmin`, and both dominion verdicts that hold turn false. Build `aud` from
  // anything but the node's own scope, and the claims no longer equal these.
  it('builds claims from the node\'s scope, with dominion over it and beneath it, and passage above', async () => {
    const seen = await rawRpcStub('CLIENT_HOST_DO', 'acme.crm').runAsSystemPrincipal(
      'system_callee_1', ['acme.crm', 'acme.crm.tenant1', 'acme', 'acme.crm2']) as any;
    expect(seen.originAuth).toEqual({
      sub: SYSTEM,
      claims: { sub: SYSTEM, profileId: SYSTEM, aud: 'acme.crm', access: { authScope: 'acme.crm', scopeAdmin: true } },
    });
    expect(seen.dominion).toEqual({ 'acme.crm': true, 'acme.crm.tenant1': true, acme: false, 'acme.crm2': false });
    expect(seen.passage.acme).toBe(true);
    expect(seen.passage['acme.crm2']).toBe(false);
  });

  // Mutations: start a fresh chain for the `'agent'` kind alone, and the callee reads
  // `system:acme.crm` as its caller's subject. Leave the system claims in place after the block,
  // and `subAfter` is `system:acme.crm`.
  it('keeps the claims inside the block: a call made there carries none, and the block before it resumes', async () => {
    const seen = await rawRpcStub('CLIENT_HOST_DO', 'acme.crm').runAsSystemPrincipal('system_callee_2', []) as any;
    expect(seen.subAfter).toBe('agent:test');
    const callee = env.TEST_DO.getByName('system_callee_2');
    const context = await vi.waitFor(async () => {
      const c = await callee.getObservedContext();
      expect(c).toBeDefined();
      return c;
    });
    expect(context.originAuth).toBeUndefined();
    expect(context.callChain).toHaveLength(1);
    expect(context.callChain[0]).toMatchObject({ bindingName: 'CLIENT_HOST_DO', instanceName: 'acme.crm' });
  });

  // `onStart` runs at a node's construction, before any call has stamped a name on it.
  // Mutation: read the stamped name alone, and both blocks throw for want of one.
  it('acts as either principal from a first construction, named by ctx.id.name', async () => {
    const node = rawRpcStub('PRINCIPAL_ONSTART_DO', 'beta.shop');
    expect(await node.kept('onstart_stamped')).toBe('none');
    expect(await node.kept('onstart_system')).toEqual(
      { sub: 'system:beta.shop', profileId: 'system:beta.shop', aud: 'beta.shop', access: { authScope: 'beta.shop', scopeAdmin: true } });
    expect(await node.kept('onstart_agent')).toEqual(
      { sub: 'agent:test', profileId: 'agent:test', aud: 'beta.shop', access: { authScope: 'beta.shop' } });
  });

  // Mutations: decide the refusal by what the name parses as, and the unscoped node named
  // `acme.crm` runs its block. Derive the scope without `parseId`, and the platform root runs its.
  it.each([
    ['a MeshWorker', () => env.TEST_WORKER.trySystemPrincipal(), /this one is a MeshWorker/],
    ['an UnscopedMeshDO constructed under a scope\'s name', () => env.TEST_DO.getByName('acme.crm').trySystemPrincipal(), /this one is an UnscopedMeshDO/],
    ['a scoped node named for the platform root', () => rawRpcStub('CLIENT_HOST_DO', '_platform').trySystemPrincipal(), /"_platform" is no scope/],
  ])('refuses %s', async (_what, attempt, message) => {
    expect(await attempt()).toMatch(message);
  });
});

describe('isPersonSub — a person\'s key is a UUID, and nothing else is', () => {
  it('answers true for a UUID in either case', () => {
    expect(isPersonSub('7c1e2f3a-4b5c-4d6e-8f70-112233445566')).toBe(true);
    expect(isPersonSub('7C1E2F3A-4B5C-4D6E-8F70-112233445566')).toBe(true);
  });

  // Mutations: test for a missing colon, and `anyone` answers true. Drop the `typeof` check, and
  // the object answers true, since a RegExp tests an object's string form.
  it.each([
    ['an agent principal', 'agent:lumenize'],
    ['a system principal', 'system:acme.crm'],
    ['a grantee key with no prefix', 'anyone'],
    ['the empty string', ''],
    ['an object whose string form is a UUID', { toString: (): string => '7c1e2f3a-4b5c-4d6e-8f70-112233445566' }],
  ])('answers false for %s', (_what, sub) => {
    expect(isPersonSub(sub)).toBe(false);
  });
});
