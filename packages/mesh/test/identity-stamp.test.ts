/**
 * Where a node keeps the identity stamp a call brings: a scoped node persists it at first contact,
 * and an unscoped node holds it in memory, persisting it only where it may later act with no call
 * to stamp from — a `@rawRpc()` entry, or an alarm row, in either order.
 *
 * vitest-plugin, because only this lane resets an object on demand (`ctx.abort()`), runs its alarm
 * by hand and reads its storage directly. A reset here keeps the object's storage, measured
 * 2026-10-09; local `wrangler dev` wipes it (`durable-objects.md` § *Persist before `ctx.abort()`*). A `/live` run cannot reach a
 * named object's KV, and a stamp held in memory is the same as one persisted until the object is
 * reset. `client-routes` checks the live half: a frame to an invented `profileId` leaves no row.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { rawRpcStub } from '../src/raw-rpc';
import type { CallEnvelope } from '../src/lmz-api';
import { loginAt, uniqueScope } from './support/login';

const KEYS = ['__lmz_do_binding_name', '__lmz_do_instance_name'] as const;

/** A node's call, as `lmz.call` builds one, to `method` on (`binding`, `instance`). */
function callTo(binding: string, instance: string, method: string, extra: Partial<CallEnvelope> = {}): CallEnvelope {
  const node = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: 'stamp-caller' };
  return {
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args: [] }]),
    callContext: { callChain: [node] },
    metadata: { caller: node, callee: { type: 'LumenizeDO', bindingName: binding, instanceName: instance } },
    ...extra,
  };
}

const storedStamp = (stub: DurableObjectStub) => runInDurableObject(stub, (_i: unknown, ctx: DurableObjectState) =>
  KEYS.map((k) => ctx.storage.kv.get(k)));

/** Reset the object, as an eviction would: a fresh instance, holding only what was persisted. */
const reset = (stub: DurableObjectStub) => runInDurableObject(stub, (_i: unknown, ctx: DurableObjectState) => {
  ctx.abort('a reset, in a test');
}).catch(() => { /* the abort rejects the call that ordered it */ });

/**
 * Reset the object, run its alarm on the fresh instance with no call to stamp it, and wait for the
 * answer the alarm's mesh call brings back. A stub to an aborted object stays broken, so a new one
 * reaches the fresh one. The alarm is a minute out, so `triggerAlarms` runs it rather than the clock.
 */
async function alarmAnswer(name: string): Promise<unknown> {
  await reset(env.STAMP_ALARM_DO.getByName(name));
  const stub = env.STAMP_ALARM_DO.getByName(name);
  expect(await runInDurableObject(stub, (instance: any) => instance.svc.alarms.triggerAlarms(1))).toEqual(['out']);
  return vi.waitFor(async () => {
    const answer = await runInDurableObject(stub, (_i: unknown, ctx: DurableObjectState) => ctx.storage.kv.get('answer'));
    expect(answer).toBeDefined();
    return answer;
  }, { timeout: 5000 });
}

describe('an unscoped node holds a call\'s stamp in memory', { timeout: 20000 }, () => {
  // MUTATION: persist the stamp at `executeEnvelope` for every node, and the row appears.
  it('persists nothing for a call it admits', async () => {
    const name = `plain-${crypto.randomUUID()}`;
    const stub = env.STAMP_ALARM_DO.getByName(name);
    expect(await (stub as any).__executeOperation(callTo('STAMP_ALARM_DO', name, 'ping'))).toEqual({ $ack: true });
    expect(await storedStamp(stub)).toEqual([undefined, undefined]);
  });

  // The held name is the one the namespace addressed, so the refusals checked the name it holds.
  // MUTATION: drop the comparison with `ctx.id.name`, and the call runs under the other name.
  it('refuses a call naming it otherwise than the namespace did', async () => {
    const name = `plain-${crypto.randomUUID()}`;
    const answer = await (env.STAMP_ALARM_DO.getByName(name) as any).__executeOperation(
      callTo('STAMP_ALARM_DO', `other-${crypto.randomUUID()}`, 'ping'));
    expect(postprocess(answer.$error).message).toMatch(new RegExp(`^DO instance name mismatch: this object is '${name}'`));
  });

  // MUTATION: drop the alarm-row persistence in `lmz.__init`, and the reset node's alarm cannot
  // name itself as its call's return address.
  it('persists it at the call that built a node whose onStart armed an alarm', async () => {
    const name = `onstart-${crypto.randomUUID()}`;
    const stub = env.STAMP_ALARM_DO.getByName(name);
    await (stub as any).__executeOperation(callTo('STAMP_ALARM_DO', name, 'ping'));
    expect(await storedStamp(stub)).toEqual(['STAMP_ALARM_DO', name]);
    expect(await alarmAnswer(name)).toBe('Echo: from the alarm');
  });

  // MUTATION: drop the persistence in `Alarms.schedule`, and the reset node's alarm cannot name
  // itself as its call's return address.
  it('persists it when a call arms an alarm', async () => {
    const name = `mesh-${crypto.randomUUID()}`;
    const stub = env.STAMP_ALARM_DO.getByName(name);
    await (stub as any).__executeOperation(callTo('STAMP_ALARM_DO', name, 'arm'));
    await vi.waitFor(async () => expect(await storedStamp(stub)).toEqual(['STAMP_ALARM_DO', name]));
    expect(await alarmAnswer(name)).toBe('Echo: from the alarm');
  });

  // MUTATION: hold the `@rawRpc()` entry's stamp in memory too, and nothing is stored.
  it('persists the stamp a @rawRpc() entry brings', async () => {
    const instance = `raw-${crypto.randomUUID()}`;
    await rawRpcStub('TEST_DO', instance).rawRpcEcho('x');
    expect(await env.TEST_DO.getByName(instance).getStoredBindingName()).toBe('TEST_DO');
  });
});

describe('a scoped node persists its stamp at first contact', { timeout: 20000 }, () => {
  // MUTATION: hold every node's envelope stamp in memory, and the keys are absent.
  it('holds both keys after one call through __executeOperation', async () => {
    const hostName = uniqueScope('stamp');
    // The claim wipes the host's node, as a creation does, so it is still never stamped after it.
    const login = await loginAt(hostName);
    const stub = env.CLIENT_HOST_DO.getByName(hostName);
    expect(await storedStamp(stub)).toEqual([undefined, undefined]);
    const claims = parseJwtUnsafe(login.accessToken)!.payload as unknown as Record<string, unknown>;
    expect(await (stub as any).__executeOperation(callTo('CLIENT_HOST_DO', hostName, 'echo', {
      callContext: {
        callChain: [{ type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: `${hostName}/${login.sub}.tab1` }],
        originAuth: { sub: login.sub, claims },
      },
    }))).toEqual({ $ack: true });
    expect(await storedStamp(stub)).toEqual(['CLIENT_HOST_DO', hostName]);
  });
});
