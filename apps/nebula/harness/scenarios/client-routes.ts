/**
 * **A scope's node routes each call its Clients make, and refuses one it may not send before any
 * other Durable Object or Worker is touched.**
 *
 * A Client's frame names a binding and an instance. Its host's Gateway runs a call for the host in
 * place, sends a call to a route the app declared with `defineRoutes` once that route's check
 * passes, and refuses everything else with a message saying why. The refusal is the Gateway's, not
 * the destination's, so the scenario checks two things per refused frame: the message, and that the
 * destination never woke.
 *
 * The caller is the admin of a tenant Star, `A`, who holds dominion over `A` and over nothing beside
 * it: a stranger who founded `A` through the real signup (`provisionStarAdmin`). A sibling Star, `B`,
 * is founded the same way by somebody else. Every frame goes down one raw socket on `A`'s host, so a
 * limb can send what a `NebulaClient` would never write.
 *
 * **How it observes.** The Gateway logs one line per frame, after any dispatch, under
 * `lmz.mesh.ClientGateway.route`, carrying the frame's `callId`; each limb waits for its own before
 * reading anything else. Each absence check is a (namespace, name) pair: a Star's construction under
 * `nebula.Star.onStart`, a Galaxy's under `nebula.Galaxy.onStart`, a Profile's under
 * `nebula-auth.Profile.onStart`, and a scoped node's passage step under
 * `lmz.mesh.ScopedMeshDO.passage`. Every matcher has a positive control showing it can fire. Both
 * venues capture the Worker's lines; three halves hold only of a fresh local stack, whose Registry and
 * shared app this run built and whose Durable Objects' files are on this machine, and a deployed
 * target says so instead.
 *
 * Limbs, all run, the verdict at the end (`live-scenarios.md`):
 *  1. **The frame's fields.** `PROFILE` at `['<B>']` and `binding: ['STAR']` are refused by the
 *     field check, and no Profile named `B` starts. Mutation: drop the field check.
 *  2. **The missing route.** `AUTH_REGISTRY` at `registry` and at a fixed probe name,
 *     `AUTH_EMAIL_SENDER`, and `__proto__` are refused with the missing-route message, and no
 *     Registry migrates a fresh schema. Mutation: forward an undeclared binding; a plain lookup.
 *  3. **Passage.** `STAR` at `B`, at a Client's address on `B`, and at a scope nobody created are
 *     refused with `noPassageMessage`'s wording; `B`'s passage step never runs, and the uncreated
 *     Star never starts. Mutation: drop the passage check.
 *  4. **The tier.** `STAR` at the app's Galaxy and `GALAXY` at `A` are refused with the tier
 *     message, and neither target starts in its own namespace. Mutation: drop the tier check.
 *  5. **The unscoped and worker routes.** `PROFILE` at `B` and at `_platform` is refused with
 *     `lmz.__init`'s message and no Profile of either name starts; `PROFILE` at `B/x`, `PROFILE`
 *     and `STAR` with no instance, and `AUTH_FACADE` at `x` each get their own message. Mutation:
 *     drop each check.
 *  6. **Positive controls.** A `GALAXY` call to the app's Galaxy, a `PROFILE` read of the caller's
 *     own profile and an `AUTH_FACADE` call each answer, and each matcher is shown able to fire.
 *  7. **A Profile nobody created stores nothing.** Under one random UUID a read answers never
 *     written, a subscribe and an unsubscribe are admitted, and a write from the caller is refused
 *     by the Profile's owner-or-admin check. The local stack's Profile files then hold no table and
 *     no row that a UUID's frames could have made, and, before trusting that, the same reader finds
 *     the table the caller's own first write creates in a file that had none. Mutation: create the
 *     schema in `onStart`, or ahead of the write's guard, or persist the stamp at `executeEnvelope`.
 *
 * Real logins (ADR-009 rung 1): the shared app's owner for the account above, and two strangers who
 * found `A` and `B` by email. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { DevStack } from '../lib/harness';
import { readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionStarAdmin, foundTenantStar } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { debugLines, LOG_WAIT_MS, waitForDebugLines, type DebugLine } from '../lib/stdio';

export const needsContainer = false;
export const bootVars = {
  DEBUG: [
    'lmz.mesh.ClientGateway.route', 'lmz.mesh.ScopedMeshDO.passage',
    'nebula.Star.onStart', 'nebula.Galaxy.onStart', 'nebula-auth.Profile.onStart', 'nebula-auth.Registry.migrate',
  ].join(','),
};

/** A frame's answer crosses the Gateway and back. Past this it is a failure, not slowness. */
const WAIT_MS = 15_000;

const NO_ROUTE = (binding: string) =>
  `No route from a Client to "${binding}": a Client reaches only the bindings declared in defineRoutes()`;

/** The local stack's Profile objects, one SQLite file each, as `wrangler dev` persists them. */
const PROFILE_STATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.wrangler/state/v3/do/nebula-Profile');

/**
 * Every Profile file's tables and KV keys, by file, read without writing. Building any object under
 * local `wrangler dev` creates its file, holding the runtime's own tables, `_cf_*` and miniflare's
 * `__miniflare_do_name` (measured 2026-10-09); those are left out, so what remains is what Mesh and
 * the Profile wrote.
 */
function profileFiles(): Map<string, { tables: string[]; kv: string[] }> {
  const out = new Map<string, { tables: string[]; kv: string[] }>();
  if (!existsSync(PROFILE_STATE)) return out;
  for (const file of readdirSync(PROFILE_STATE).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')) {
    const db = new DatabaseSync(resolve(PROFILE_STATE, file), { readOnly: true });
    try {
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      const kv = tables.includes('_cf_KV')
        ? (db.prepare('SELECT key FROM _cf_KV').all() as Array<{ key: string }>).map((r) => r.key) : [];
      out.set(file, { tables: tables.filter((n) => !n.startsWith('_cf_') && !n.startsWith('__miniflare')), kv });
    } finally {
      db.close();
    }
  }
  return out;
}

/** What a frame came back with: the value its handler was filled with, or the Error's message. */
type Answer = { ok: true; value: unknown } | { ok: false; message: string };

function jwtPayload(token: string): Record<string, any> {
  const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const starA = `${app.galaxy}.${testSlug('routes-a')}`;
  const starB = `${app.galaxy}.${testSlug('routes-b')}`;
  const uncreated = `${app.galaxy}.${testSlug('routes-none')}`;

  const caller = await provisionStarAdmin({ baseUrl: origin, scope: starA, testToken, ownerEmail: app.ownerEmail });
  const founderB = await foundTenantStar({ baseUrl: origin, star: starB, testToken });
  assert.ok(founderB, `${starB} could not be founded`);
  const profileId = jwtPayload(caller.accessToken).profileId as string;

  const failures: string[] = [];
  const limb = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const local = process.env.HARNESS_TARGET_URL === undefined;
  const entries = (): DebugLine[] => debugLines(stack.logs());
  const named = (namespace: string, name: string, key = 'name') =>
    entries().filter((e) => e.namespace === namespace && e.data[key] === name);

  // ── One raw socket on A's host, which a limb can send any frame down ───────────────────────────
  const gateway = `${scopeUrlOf(stack, starA).replace(/^http/, 'ws').replace(/\/$/, '')}/gateway/${caller.sub}.routes`;
  const ws = new WebSocket(gateway, ['lmz.2', `lmz.access-token.${caller.accessToken}`]);
  const answers = new Map<string, (answer: Answer) => void>();
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('message', function ready(e) {
        if (JSON.parse(String(e.data)).type === 'connection_status') { ws.removeEventListener('message', ready); resolve(); }
      });
      ws.addEventListener('error', () => reject(new Error(`the socket on ${starA}'s host did not open`)));
    });
    ws.addEventListener('message', (e) => {
      const text = String(e.data);
      if (!text.startsWith('{')) return;
      const frame = JSON.parse(text);
      if (frame.type !== 'response') return;
      const settle = answers.get(frame.callId);
      if (!settle) return;
      const filled = postprocess(frame.chain) as Array<{ args?: unknown[] }>;
      const value = filled.at(-1)?.args?.at(-1);
      settle(value instanceof Error ? { ok: false, message: value.message } : { ok: true, value });
    });

    let seq = 0;
    /** Send one call frame, raw, and wait for its answer and, locally, its Gateway line. */
    async function send(binding: unknown, instance: unknown, chain: unknown[]): Promise<Answer & { callId: string }> {
      const callId = `routes-${++seq}`;
      const answered = new Promise<Answer>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, message: '(no answer)' }), WAIT_MS);
        answers.set(callId, (a) => { clearTimeout(timer); resolve(a); });
      });
      ws.send(JSON.stringify({
        type: 'call', callId, loadId: 'routes-load', binding, instance,
        chain: preprocess(chain),
        handler: preprocess([{ type: 'get', key: 'onAnswer' }, { type: 'apply', args: [] }]),
      }));
      const answer = await answered;
      await waitForDebugLines(stack, (all) => all.some((l) =>
        l.namespace === 'lmz.mesh.ClientGateway.route' && l.data.callId === callId), `the Gateway's line for ${callId}`);
      return { ...answer, callId };
    }
    const op = (key: string, ...args: unknown[]) => [{ type: 'get', key }, { type: 'apply', args }];
    const refusedWith = (a: Answer, expected: string | RegExp) =>
      !a.ok && (typeof expected === 'string' ? a.message === expected : expected.test(a.message));
    const said = (a: Answer) => (a.ok ? `answered ${JSON.stringify(a.value)}` : `refused with "${a.message}"`);
    /** Assert a log half once its line can have arrived, polling up to `LOG_WAIT_MS`: a deployed
     *  capture delivers an invocation's lines when it ends, which can be after its answer. A count
     *  only grows, so a negative that fails stays failed rather than passing late. */
    const logHalf = async (name: string, ok: () => boolean, detail: string) => {
      const deadline = Date.now() + LOG_WAIT_MS;
      while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      limb(name, ok(), detail);
    };
    /** A half that holds only of a fresh local stack: a deployed target's Registry and shared app
     *  were built before this run. */
    const localHalf = async (name: string, ok: () => boolean, detail: string) => {
      if (!local) console.log(`  · ${name}: a fresh local stack only`);
      else await logHalf(name, ok, detail);
    };

    // ── LIMB 6 first: positive controls, so every matcher is shown able to fire ─────────────────
    const galaxyCall = await send('GALAXY', app.galaxy, op('getCurrentOntology'));
    limb('limb 6 — a GALAXY call to the app\'s Galaxy answers', galaxyCall.ok, said(galaxyCall));
    const profileCall = await send('PROFILE', profileId, op('read'));
    limb('limb 6 — a PROFILE read of the caller\'s own profile answers', profileCall.ok, said(profileCall));
    const facadeCall = await send('AUTH_FACADE', undefined, op('expandScope'));
    limb('limb 6 — an AUTH_FACADE call answers', facadeCall.ok, said(facadeCall));
    await logHalf('limb 6 — the passage matcher fires for the app\'s Galaxy',
      () => named('lmz.mesh.ScopedMeshDO.passage', app.galaxy, 'instanceName').length > 0, 'no passage entry named it');
    await localHalf('limb 6 — the Galaxy matcher fires for the app\'s Galaxy',
      () => named('nebula.Galaxy.onStart', app.galaxy).length > 0, 'no Galaxy start named it');
    await logHalf('limb 6 — the Star matcher fires for B, started when it was founded',
      () => named('nebula.Star.onStart', starB).length > 0, 'no Star start named it');
    await logHalf('limb 6 — the Profile matcher fires for the caller\'s own profile',
      () => named('nebula-auth.Profile.onStart', profileId).length > 0, 'no Profile start named it');

    // ── LIMB 1: the frame's fields ─────────────────────────────────────────────────────────────
    const fieldMessage = /binding must be a non-empty string/;
    const arrayInstance = await send('PROFILE', [starB], op('read'));
    limb('limb 1 — PROFILE at an array is refused by the field check', refusedWith(arrayInstance, fieldMessage), said(arrayInstance));
    const arrayBinding = await send(['STAR'], starA, op('read'));
    limb('limb 1 — an array binding is refused by the field check', refusedWith(arrayBinding, fieldMessage), said(arrayBinding));
    await logHalf('limb 1 — no Profile named B started', () => named('nebula-auth.Profile.onStart', starB).length === 0, 'a Profile named B started');

    // ── LIMB 2: the missing route ───────────────────────────────────────────────────────────────
    const freshSchemas = () => entries().filter((e) =>
      e.namespace === 'nebula-auth.Registry.migrate' && Number(e.data.rowsWritten) > 0).length;
    const schemasBefore = freshSchemas();
    // The stack's one Registry migrated a fresh schema at the first login, so the matcher can fire.
    await localHalf('limb 2 — the fresh-schema matcher fires for the Registry the logins built',
      () => schemasBefore > 0, 'no Registry logged a fresh schema');
    for (const [binding, instance] of [
      ['AUTH_REGISTRY', 'registry'], ['AUTH_REGISTRY', 'client-routes-probe'], ['AUTH_EMAIL_SENDER', undefined], ['__proto__', 'x'],
    ] as const) {
      const a = await send(binding, instance, op('read'));
      limb(`limb 2 — ${binding}${instance ? ` at ${instance}` : ''} is refused with the missing-route message`,
        refusedWith(a, NO_ROUTE(binding)), said(a));
    }
    await logHalf('limb 2 — no Registry migrated a fresh schema', () => freshSchemas() === schemasBefore, 'a fresh Registry was built');

    // ── LIMB 3: passage ─────────────────────────────────────────────────────────────────────────
    const passageEntriesB = () => named('lmz.mesh.ScopedMeshDO.passage', starB, 'instanceName').length;
    const passageBefore = passageEntriesB();
    const noPassage = (into: string) => `No passage from "${starA}" into "${into}"`;
    const sibling = await send('STAR', starB, op('getCurrentOntology'));
    limb('limb 3 — STAR at the sibling is refused for lack of passage', refusedWith(sibling, noPassage(starB)), said(sibling));
    const siblingClient = await send('STAR', `${starB}/someone.tab1`, op('receive'));
    limb('limb 3 — STAR at a Client on the sibling is refused for lack of passage',
      refusedWith(siblingClient, noPassage(starB)), said(siblingClient));
    await logHalf('limb 3 — the sibling\'s passage step never ran', () => passageEntriesB() === passageBefore, 'the sibling\'s passage step ran');
    const none = await send('STAR', uncreated, op('getCurrentOntology'));
    limb('limb 3 — STAR at a scope nobody created is refused for lack of passage', refusedWith(none, noPassage(uncreated)), said(none));
    await logHalf('limb 3 — the uncreated Star never started', () => named('nebula.Star.onStart', uncreated).length === 0, 'it started');

    // ── LIMB 4: the tier ────────────────────────────────────────────────────────────────────────
    const starAtGalaxy = await send('STAR', app.galaxy, op('getCurrentOntology'));
    limb('limb 4 — STAR at the app\'s Galaxy is refused with the tier message',
      refusedWith(starAtGalaxy, `"${app.galaxy}" is a galaxy scope, which "STAR" does not serve`), said(starAtGalaxy));
    await logHalf('limb 4 — no Star named the app\'s Galaxy started', () => named('nebula.Star.onStart', app.galaxy).length === 0, 'it started');
    const galaxyAtStar = await send('GALAXY', starA, op('getCurrentOntology'));
    limb('limb 4 — GALAXY at the caller\'s own Star is refused with the tier message',
      refusedWith(galaxyAtStar, `"${starA}" is a star scope, which "GALAXY" does not serve`), said(galaxyAtStar));
    await logHalf('limb 4 — no Galaxy named the caller\'s Star started', () => named('nebula.Galaxy.onStart', starA).length === 0, 'it started');

    // ── LIMB 5: the unscoped and worker routes ──────────────────────────────────────────────────
    for (const name of [starB, '_platform']) {
      const a = await send('PROFILE', name, op('read'));
      limb(`limb 5 — PROFILE at ${name} is refused with lmz.__init's message`,
        refusedWith(a, `"${name}" parses as a scope, and an UnscopedMeshDO never runs under a scope's name — name it by an id, such as a UUID, or extend ScopedMeshDO`),
        said(a));
      await logHalf(`limb 5 — no Profile named ${name} started`, () => named('nebula-auth.Profile.onStart', name).length === 0, 'it started');
    }
    const address = await send('PROFILE', `${starB}/x`, op('read'));
    limb('limb 5 — PROFILE at a Client\'s address is refused with its own message',
      refusedWith(address, `"PROFILE" serves nodes, and "${starB}/x" is a Client's address`), said(address));
    const noInstance = await send('PROFILE', undefined, op('read'));
    limb('limb 5 — PROFILE with no instance is refused with its own message',
      refusedWith(noInstance, /^"PROFILE" serves nodes named by an id/), said(noInstance));
    const scopedNoInstance = await send('STAR', undefined, op('getCurrentOntology'));
    limb('limb 5 — STAR with no instance is refused with its own message',
      refusedWith(scopedNoInstance, /^"STAR" serves nodes named by a scope/), said(scopedNoInstance));
    const workerInstance = await send('AUTH_FACADE', 'x', op('expandScope'));
    limb('limb 5 — AUTH_FACADE at an instance is refused with its own message',
      refusedWith(workerInstance, /^"AUTH_FACADE" is a Worker, which takes no instance/), said(workerInstance));

    // ── LIMB 7: a Profile nobody created stores nothing ─────────────────────────────────────────
    const before = profileFiles();
    const invented = crypto.randomUUID();
    const neverWritten = (a: Answer) => a.ok && (a.value as { meta?: { eTag?: string } } | undefined)?.meta?.eTag
      === '00000000000000000000000000';
    const inventedRead = await send('PROFILE', invented, op('read'));
    limb('limb 7 — a read of a Profile nobody created answers never written', neverWritten(inventedRead), said(inventedRead));
    const inventedSubscribe = await send('PROFILE', invented, op('subscribe'));
    limb('limb 7 — a subscribe there is admitted', inventedSubscribe.ok, said(inventedSubscribe));
    const inventedUnsubscribe = await send('PROFILE', invented, op('unsubscribe'));
    limb('limb 7 — an unsubscribe there is admitted', inventedUnsubscribe.ok, said(inventedUnsubscribe));
    const inventedWrite = await send('PROFILE', invented, op('writeProfile', { nickname: 'not mine' }));
    limb('limb 7 — the caller\'s write there is refused by the owner-or-admin check',
      refusedWith(inventedWrite, /^Forbidden: /), said(inventedWrite));
    if (!local) {
      console.log('  · whether a Profile nobody created stored anything: a local stack only, whose files are on this machine');
    } else {
      const after = profileFiles();
      const madeByTheUuid = [...after].filter(([file, s]) => {
        const was = before.get(file);
        return s.tables.length > (was?.tables.length ?? 0) || s.kv.length > (was?.kv.length ?? 0);
      });
      limb('limb 7 — no Profile file gained a table or a row from the invented id\'s frames',
        madeByTheUuid.length === 0, `changed: ${JSON.stringify(madeByTheUuid)}`);
      console.log(`  · ${after.size - before.size} new Profile file(s) under the invented id's frames`);
      // The reader can see a Profile's storage: the caller's own first write creates its table.
      const ownWrite = await send('PROFILE', profileId, op('writeProfile', { nickname: 'Routes' }));
      limb('limb 7 — the caller\'s write of its own Profile is admitted', ownWrite.ok, said(ownWrite));
      const written = [...profileFiles()].some(([file, s]) =>
        s.tables.includes('ProfileFields') && !(after.get(file)?.tables.includes('ProfileFields') ?? false));
      limb('limb 7 — the reader finds the table the caller\'s own first write created', written,
        'no Profile file gained a ProfileFields table at the caller\'s write');
    }
  } finally {
    ws.close();
  }

  assert.equal(failures.length, 0, failures.join('\n'));
}
