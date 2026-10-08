/**
 * Galaxy @mesh surface + resource facet (the `dev-studio` project — its name predates
 * the collapse of DevStudio into Galaxy).
 *
 * Two things, neither needing a client:
 *  1. **Frozen surface, in THREE tiers plus what the door hands back.** Every entry reachable
 *     on the Galaxy's whole prototype chain: the bare `@mesh()` door `resources` and the
 *     registry and config reads; the source entries — every entry `LOOP_TOOL_ENTRIES` names plus
 *     the Apply — at the CHAT FLOOR (`requireChatWrite`, the door a Message create passes); and
 *     configuration at dominion; the inherited `teardown` is `@rawRpc()`, on no tier. Past the door the plane's
 *     `requests` and `results` member lists are frozen, and so is `OrgTree`'s, which `requests`
 *     hands out as `orgTree` — past a gate nothing is checked, so a member added there is on the
 *     wire the moment it is written. The deleted initial-load cue (`warmPreview`) stays deleted
 *     on both ends.
 *  2. **Facet behavior on Galaxy:** the composed Session/Message provider mounts +
 *     enforces the ADR-006 embed-guard (SC3), coexists with the tool-args facet in
 *     one DO without bundleId cross-wiring (M2), and survives an `onStart` re-init
 *     with an unchanged version (M3).
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { isMeshCallable } from '@lumenize/mesh';
import { meshEntries } from '../mesh-surface';
import { Galaxy, requireChatWrite, LOOP_TOOL_ENTRIES } from '../../../src/galaxy';
import { NebulaClient } from '../../../../../packages/resources/src/nebula-client';
import { requireDominionHere } from '../../../src/nebula-do';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '../../../src/chat-constants';

// ─── driver — direct in-DO call ────────────────────────────────────────────
// These `*ForTest` methods are PURE (they read `this.ctx`/`this.env.LOADER`, no callContext, no
// cross-DO call), so run them directly in-DO to get the RETURN VALUE. Driving them through the mesh
// `__executeOperation` path is no longer usable here: it EARLY-ACKS (returns `{$ack}`) and runs the
// chain in a detached `waitUntil` task, so the result would travel via fire-back, unobservable from
// a bare envelope. The guard on the entry is not what these facet-behavior tests exercise (the
// three-tier *surface* is frozen statically above), so bypassing it is correct.
const uniqueGalaxyScope = () => `u${crypto.randomUUID().slice(0, 8)}.app`;
async function callGalaxy(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).GALAXY.getByName(instance);
  return (runInDurableObject as any)(stub, (inst: any) => inst[method](...args));
}
/** Run `fn` inside a Galaxy and return what it returns. */
async function callGalaxyInDO<T>(instance: string, fn: (inst: unknown) => T): Promise<T> {
  return (runInDurableObject as any)((env as any).GALAXY.getByName(instance), fn);
}

type Tier = 'bare' | 'chat' | 'dominion';

/** The Galaxy's mesh entries of one guard tier, over its whole prototype chain. */
function meshMethods(tier: Tier): string[] {
  return meshEntries(Galaxy)
    .filter(({ guard }) => (guard === requireDominionHere ? 'dominion' : guard === requireChatWrite ? 'chat' : 'bare') === tier)
    .map(({ name }) => name);
}

/** Every name a surface object exposes, own and inherited, stopping before Object.prototype. */
function surfaceNames(surface: object): string[] {
  const seen = new Set<string>();
  for (let o: object | null = surface; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor') seen.add(n);
  }
  return [...seen].sort();
}

describe('Galaxy @mesh surface freeze — three guard tiers, and what the door hands back', () => {
  // Freeze the bare surface: a resource method accidentally shipped with a guard LEAVES
  // this set (→ red); a source or config method accidentally shipped bare ENTERS it (→ red).
  it('bare @mesh surface == the resource + registry-read surface, exactly', () => {
    expect(meshMethods('bare')).toEqual(
      [
        // Ontology-registry reads — passage-gated only: getCurrentOntology is what a Star's pull
        // reads, and getOntologyVersion one applied row by label (every member of a descendant
        // scope reaches both).
        'getCurrentOntology', 'getGalaxyConfig', 'getOntologyVersion',
        // The one door onto the resource plane — every op, the org tree and the node invite
        // behind it check themselves (chat participants are non-admin but DAG-granted).
        'resources',
      ].sort(),
    );
  });

  it('every entry LOOP_TOOL_ENTRIES names sits at the CHAT FLOOR (requireChatWrite), and so does the Apply', () => {
    // Mutation: restore `requireDominionHere` on `writeSource` → it leaves this set → red.
    const chat = meshMethods('chat');
    const named = [...new Set(Object.values(LOOP_TOOL_ENTRIES).flat())];
    expect(named.length).toBeGreaterThan(0); // the table is not empty (positive control)
    for (const entry of named) expect(chat).toContain(entry);
    // The exact chat-floor set: the table's three entries and the dev Apply, whose wipe
    // bit is decided in the body at dominion over the `.dev` Star.
    expect(chat).toEqual(['applyOntology', 'buildNow', 'readSource', 'writeSource']);
  });

  it('the DOMINION list is exactly Galaxy configuration', () => {
    // A source entry accidentally shipped with requireDominionHere ENTERS this set → red;
    // a config method dropped to the chat floor LEAVES it → red. `NebulaDO.teardown` carries
    // `@rawRpc()`, never `@mesh()`, so the walk up the whole chain does not find it.
    expect(meshMethods('dominion')).toEqual(['setGalaxyConfig']);
  });

  it('what the door hands back is frozen: `requests`, `results`, and the `OrgTree` behind `requests.orgTree`', async () => {
    // Past the gate nothing is checked, so every member here is wire-reachable (`requests`) or
    // reached by the node's own answers (`results`, behind an undecorated getter). Read off a live
    // Galaxy, since both are closures built per plane.
    const surfaces = await callGalaxyInDO(uniqueGalaxyScope(), (inst: any) => ({
      requests: surfaceNames(inst.resources),
      results: surfaceNames(inst.resourcesResults),
      orgTreeOwn: Object.getOwnPropertyNames(inst.resources.orgTree),
      orgTreeMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(inst.resources.orgTree))
        .filter((n) => n !== 'constructor').sort(),
    }));
    expect(surfaces.requests).toEqual([
      'invite', 'orgTree', 'read', 'subscribe', 'subscribeQuery', 'subscribeQuerySubscribers', 'subscribeTree',
      'transaction', 'unsubscribe', 'unsubscribeQuery', 'unsubscribeQuerySubscribers',
    ]);
    expect(surfaces.results).toEqual([
      'onBroadcastResult', 'onInviteResult', 'onOntologyPulled', 'onPushUndelivered', 'onQueryBroadcastResult',
      'onQuerySubscriberListBroadcastResult', 'onTreeBroadcastResult',
    ]);
    // The OrgTree's own state is `#` fields only: a TypeScript-`private` field is an own property,
    // walked like any other, and would put the tree's cache on the wire.
    expect(surfaces.orgTreeOwn).toEqual([]);
    // Every public method is wire-reachable as `resources.orgTree.<name>`; each checks itself.
    expect(surfaces.orgTreeMethods).toEqual([
      'addEdge', 'checkPermission', 'createNode', 'deleteNode', 'evaluatePermissions', 'getEffectivePermission',
      'getNodeAncestors', 'getNodeDescendants', 'getState', 'relabelNode', 'removeEdge', 'renameNode',
      'reparentNode', 'requirePermission', 'revokePermission', 'setPermission', 'undeleteNode',
    ]);
  });

  it('warmPreview is gone on BOTH ends — the Galaxy and the NebulaClient prototypes', () => {
    // The initial-load cue did nothing the client had not already done (the iframe src is
    // set before connecting; dist serves from the Galaxy's VFS) and was refused silently
    // on every collaborator's load. The build reply keeps `deliverPreviewReady`.
    expect((Galaxy.prototype as unknown as Record<string, unknown>).warmPreview).toBeUndefined();
    expect((NebulaClient.prototype as unknown as Record<string, unknown>).warmPreview).toBeUndefined();
    expect(typeof (Galaxy.prototype as unknown as Record<string, unknown>).deliverPreviewReady).toBe('function');
  });

  it('the entry-reaching deps runCodegenTurn builds have EXACTLY the table\'s keys', async () => {
    // Mutation: add a dep the table does not list (or drop `build`) → red. The probe reads
    // `loopToolDeps()`, `runCodegenTurn`'s only source of tool deps (one call site), so the
    // literal list is the assertion — comparing against `Object.keys(LOOP_TOOL_ENTRIES)`
    // would compare the value with its own source.
    const keys = await callGalaxy(uniqueGalaxyScope(), 'loopToolDepKeysForTest') as string[];
    expect(keys).toEqual(['build', 'edit_file', 'read_file', 'write_file']);
  });

  it('onInviteResult is gone from the Galaxy, and `resourcesResults`, where it now lives, has no `@mesh()`', () => {
    // The invite's fire-back lands through `resourcesResults.onInviteResult`. A host forward,
    // decorated or not, would be a second route to that body; `@mesh()` on the getter would also
    // open `onOntologyPulled`, which installs whatever row it is handed.
    expect('onInviteResult' in Galaxy.prototype).toBe(false);
    const d = Object.getOwnPropertyDescriptor(Galaxy.prototype, 'resourcesResults')!;
    expect(typeof d.get).toBe('function'); // positive control: the fence exists, as a getter
    expect(isMeshCallable(d.get as (...a: unknown[]) => unknown)).toBe(false);
  });

  it('the mesh surface offers NO `chat` method at all — the commit IS the trigger', () => {
    // Since the Galaxy collapse, the committed human Message triggers codegen; an invocable
    // `chat` husk — even bare-@mesh — would let a mere passage-holder run the loop with
    // no door (the DAG write check on the Message commit is the ONLY door). The runner
    // survives as the non-mesh `runTriggeredTurn`, unreachable remotely.
    const proto = Galaxy.prototype as unknown as Record<string, unknown>;
    expect(proto.chat).toBeUndefined();
    const runner = proto.runTriggeredTurn;
    expect(typeof runner).toBe('function');
    expect(isMeshCallable(runner as (...a: unknown[]) => unknown)).toBe(false);
  });
});

describe('Galaxy Session/Message facet (composed provider)', () => {
  const validTurn = { chat: 'chat-1', content: 'hello' };

  it('SC3 + M2: accepts a Message whose chat is an id string (both facets mounted → no cross-wiring)', async () => {
    const g = uniqueGalaxyScope();
    const r = await callGalaxy(g, 'parseChatMessageForTest', ['Message', validTurn]);
    expect(r.valid).toBe(true);
  });

  it('SC3: rejects an embedded chat object with the ADR-006 by-id (embed) guard', async () => {
    const g = uniqueGalaxyScope();
    const embedded = { chat: { title: 'embedded not an id' }, content: 'x' };
    const r = await callGalaxy(g, 'parseChatMessageForTest', ['Message', embedded]);
    expect(r.valid).toBe(false);
    const err = r.errors.find((e: { path: string }) => e.path === '$input.chat');
    expect(err).toBeDefined();
    // The loud warning explains the by-id relationship contract (names field + target).
    expect(err.description).toMatch(/reference by id/i);
  });

  it('the getOntology() seam carries relationships (Message.chat is to-one)', async () => {
    const g = uniqueGalaxyScope();
    const rels = await callGalaxy(g, 'resourceRelationshipsForTest') as
      Record<string, Record<string, { target: string; cardinality: string }>>;
    // Capable-of-failing: drop `relationships` from the provider closure → this is
    // `undefined` and the `.Message.session` access throws (red). subscribeQuery field
    // validation has nothing to check without this.
    expect(rels.Message.chat).toMatchObject({ target: 'Chat', cardinality: 'one' });
  });

  it('M3: ontology version is the fixed constant and survives an onStart re-init', async () => {
    const g = uniqueGalaxyScope();
    expect(await callGalaxy(g, 'resourceOntologyVersionForTest')).toBe(CHAT_MESSAGE_ONTOLOGY_VERSION);
    await callGalaxy(g, 'reInitForTest');
    // Re-derivable from the platform constant — a write still validates, version unchanged.
    const r = await callGalaxy(g, 'parseChatMessageForTest', ['Message', validTurn]);
    expect(r.valid).toBe(true);
    expect(await callGalaxy(g, 'resourceOntologyVersionForTest')).toBe(CHAT_MESSAGE_ONTOLOGY_VERSION);
  });
});
