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
 *
 * The stamp is one record under one key, with the origin a node's own pages are served on beside
 * its two names. The origin cases upgrade straight to the node, as the Worker's forward delivers a
 * Client's upgrade, so each can name the host and port it arrived on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { rawRpcStub } from '../src/raw-rpc';
import type { CallEnvelope } from '../src/lmz-api';
import { loginAt, uniqueScope, type Login } from './support/login';

const ADDRESS_KEY = '__lmz_do_address';
/** The keys the two names had before they merged: nothing may write them. */
const RETIRED_KEYS = ['__lmz_do_binding_name', '__lmz_do_instance_name'] as const;

interface StoredAddress { bindingName?: string; instanceName?: string; origin?: string }

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

const storedAddress = (stub: DurableObjectStub) => runInDurableObject(stub, (_i: unknown, ctx: DurableObjectState) =>
  ctx.storage.kv.get(ADDRESS_KEY) as StoredAddress | undefined);

/** The two names a node has stored, read from its address record. */
const storedStamp = async (stub: DurableObjectStub) => {
  const address = await storedAddress(stub);
  return [address?.bindingName, address?.instanceName];
};

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
    // No row at all, and so no origin: an unscoped node hosts no Clients.
    expect(await storedAddress(stub)).toBeUndefined();
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
    // MUTATION: keep writing a key per name, and the retired keys hold them.
    expect(await runInDurableObject(stub, (_i: unknown, ctx: DurableObjectState) =>
      RETIRED_KEYS.map((k) => ctx.storage.kv.get(k)))).toEqual([undefined, undefined]);
  });

  // MUTATION: drop the comparison in `__init`, and the call runs under the second binding's name.
  it('refuses a call that names it by another binding', async () => {
    const hostName = uniqueScope('stamp');
    const login = await loginAt(hostName);
    const stub = env.CLIENT_HOST_DO.getByName(hostName);
    const claims = parseJwtUnsafe(login.accessToken)!.payload as unknown as Record<string, unknown>;
    const callContext = {
      callChain: [{ type: 'LumenizeClient' as const, bindingName: 'CLIENT_HOST_DO', instanceName: `${hostName}/${login.sub}.tab1` }],
      originAuth: { sub: login.sub, claims },
    };
    await (stub as any).__executeOperation(callTo('CLIENT_HOST_DO', hostName, 'echo', { callContext }));
    const answer = await (stub as any).__executeOperation(callTo('OTHER_BINDING', hostName, 'echo', { callContext }));
    expect(postprocess(answer.$error).message).toMatch(/^DO binding name mismatch: stored 'CLIENT_HOST_DO' but received 'OTHER_BINDING'/);
  });
});

describe('a scoped node stores the origin its own pages are served on', { timeout: 20000 }, () => {
  let entries: DebugLogOutput[] = [];
  beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e)); });
  afterEach(() => clearDebugSink());

  /** How many times the address record was written with an origin, by the one write site's line. */
  const originWrites = () => entries.filter((e) => e.namespace === 'lmz.mesh.address' && e.data?.origin !== undefined).length;

  /** A Client's upgrade as the Worker's forward delivers it, arriving on `origin`. */
  function upgradeOn(origin: string, host: string, login: Login, tab: string, subprotocol = 'lmz.2'): Promise<Response> {
    return env.CLIENT_HOST_DO.getByName(host).fetch(`${origin}/gateway/CLIENT_HOST_DO/${host}/${login.sub}.${tab}`, {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': subprotocol,
        'Authorization': `Bearer ${login.accessToken}`,
        'X-Lumenize-DO-Instance-Name-Or-Id': host,
        'X-Lumenize-DO-Binding-Name': 'CLIENT_HOST_DO',
      },
    });
  }

  async function accepted(origin: string, host: string, login: Login, tab: string): Promise<void> {
    const res = await upgradeOn(origin, host, login, tab);
    expect(res.status).toBe(101);
    res.webSocket!.accept();
  }

  // MUTATIONS: write on every upgrade, and the second upgrade adds a line; write only when no
  // origin is stored, and the port change is lost.
  it('writes it at the first accepted upgrade, not again for the same origin, and again for another port', async () => {
    const host = uniqueScope('origin');
    const login = await loginAt(host);
    const stub = env.CLIENT_HOST_DO.getByName(host);
    const on5174 = `http://${host}.lumenize.localhost:5174`;

    await accepted(on5174, host, login, 'tab1');
    expect((await storedAddress(stub))?.origin).toBe(on5174);
    expect(originWrites()).toBe(1);

    await accepted(on5174, host, login, 'tab2');
    expect(originWrites()).toBe(1);

    const on8787 = `http://${host}.lumenize.localhost:8787`;
    await accepted(on8787, host, login, 'tab3');
    expect((await storedAddress(stub))?.origin).toBe(on8787);
    expect(originWrites()).toBe(2);
  });

  // A `.dev` Star hosts its personas' pages on hosts of their own, which share its scheme and port.
  // MUTATION: compare whole origins, and the second host rewrites the record.
  it('rewrites nothing for another host with the same scheme and port', async () => {
    const host = uniqueScope('origin');
    const login = await loginAt(host);
    const stub = env.CLIENT_HOST_DO.getByName(host);
    const own = `http://${host}.lumenize.localhost:5174`;
    await accepted(own, host, login, 'tab1');
    await accepted(`http://manny--${host}.lumenize.localhost:5174`, host, login, 'tab2');
    expect((await storedAddress(stub))?.origin).toBe(own);
    expect(originWrites()).toBe(1);
  });

  // MUTATION: set the origin before the Gateway accepts, and a refused upgrade stores one.
  it('stores none for an upgrade the Gateway refuses', async () => {
    const host = uniqueScope('origin');
    const login = await loginAt(host);
    const stub = env.CLIENT_HOST_DO.getByName(host);
    const res = await upgradeOn(`http://${host}.lumenize.localhost:5174`, host, login, 'tab1', 'not-lmz');
    expect(res.status).not.toBe(101);
    expect((await storedAddress(stub))?.origin).toBeUndefined();
    expect(originWrites()).toBe(0);
  });

  // A call from a Client another node hosts carries that node's origin, never this one's.
  // MUTATION: fill the origin from an arriving call's `originRequest`, and this node stores it.
  it('takes none from a call that arrives carrying another host\'s origin', async () => {
    const host = uniqueScope('origin');
    const login = await loginAt(host);
    const stub = env.CLIENT_HOST_DO.getByName(host);
    const claims = parseJwtUnsafe(login.accessToken)!.payload as unknown as Record<string, unknown>;
    expect(await (stub as any).__executeOperation(callTo('CLIENT_HOST_DO', host, 'echo', {
      callContext: {
        callChain: [{ type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: `elsewhere/${login.sub}.tab1` }],
        originAuth: { sub: login.sub, claims },
        originRequest: { origin: 'http://elsewhere.lumenize.localhost:9999' },
      },
    }))).toEqual({ $ack: true });
    const address = await storedAddress(stub);
    expect([address?.bindingName, address?.origin]).toEqual(['CLIENT_HOST_DO', undefined]);
  });

  // The origin is storage, so a reset keeps it, as it keeps the names.
  it('keeps its origin across a reset', async () => {
    const host = uniqueScope('origin');
    const login = await loginAt(host);
    const own = `http://${host}.lumenize.localhost:5174`;
    await accepted(own, host, login, 'tab1');
    await reset(env.CLIENT_HOST_DO.getByName(host));
    expect(await storedAddress(env.CLIENT_HOST_DO.getByName(host))).toEqual(
      { bindingName: 'CLIENT_HOST_DO', instanceName: host, origin: own });
  });
});
