/**
 * Galaxy @mesh surface + resource facet (the `dev-studio` project — its name predates
 * the collapse of DevStudio into Galaxy).
 *
 * Two things, neither needing a Gateway/client:
 *  1. **Frozen @mesh surface (m5), in THREE tiers:** the resource methods are bare
 *     `@mesh()` (DAG-gated per op inside the plane); the source entries — every entry
 *     `LOOP_TOOL_ENTRIES` names plus the Apply — sit at the CHAT FLOOR
 *     (`requireChatWrite`, the door a Message create passes); Galaxy configuration keeps
 *     `requireDominionHere`. The invite RESULT handler is not mesh-callable at all (the
 *     forge-grant fence), and the deleted initial-load cue (`warmPreview`) stays deleted
 *     on both ends.
 *  2. **Facet behavior on Galaxy:** the composed Session/Message provider mounts +
 *     enforces the ADR-006 embed-guard (SC3), coexists with the tool-args facet in
 *     one DO without bundleId cross-wiring (M2), and survives an `onStart` re-init
 *     with an unchanged version (M3).
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { Galaxy, requireChatWrite, LOOP_TOOL_ENTRIES } from '../../../src/galaxy';
import { NebulaClient } from '../../../src/nebula-client';
import { requireDominionHere } from '../../../src/nebula-do';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '../../../src/chat-constants';

// ─── driver — direct in-DO call ────────────────────────────────────────────
// These `*ForTest` methods are PURE (they read `this.ctx`/`this.env.LOADER`, no callContext, no
// cross-DO call), so run them directly in-DO to get the RETURN VALUE. Driving them through the mesh
// `__executeOperation` path is no longer usable here: it EARLY-ACKS (returns `{$ack}`) and runs the
// chain in a detached `waitUntil` task, so the result would travel via fire-back, unobservable from
// a bare envelope. The guard on the entry is not what these facet-behavior tests exercise (the
// three-tier *surface* is frozen statically above), so bypassing it is correct.
const uniqueGalaxyScope = () => `${crypto.randomUUID()}.app`;
async function callGalaxy(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).GALAXY.getByName(instance);
  return (runInDurableObject as any)(stub, (inst: any) => inst[method](...args));
}

type Tier = 'bare' | 'chat' | 'dominion';

/** Walk Galaxy's OWN prototype for mesh-callable methods, partitioned by guard tier. */
function meshMethods(tier: Tier): string[] {
  const proto = Galaxy.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    const guard = getMeshGuard(fn);
    const actual: Tier = guard === requireDominionHere ? 'dominion' : guard === requireChatWrite ? 'chat' : 'bare';
    if (actual === tier) out.push(name);
  }
  return out.sort();
}

describe('Galaxy @mesh surface freeze (m5) — three guard tiers', () => {
  // Freeze the bare surface: a resource method accidentally shipped with a guard LEAVES
  // this set (→ red); a source or config method accidentally shipped bare ENTERS it (→ red).
  it('bare @mesh surface == the resource + registry-read surface, exactly', () => {
    expect(meshMethods('bare')).toEqual(
      [
        // Ontology-registry reads — passage-gated only; getOntologyVersion is the
        // Star's UPWARD lazy-pull target and getCurrentOntology its first-touch arm
        // (every member of a descendant scope reaches both).
        'getCurrentOntology', 'getGalaxyConfig', 'getOntologyVersion',
        // The DagTree gate + the invite ENTRY (DAG-gated per-op inside the plane).
        'dagTree', 'invite',
        // The resource data-plane surface — chat participants are non-admin but DAG-granted.
        'read', 'subscribe', 'subscribeQuery', 'subscribeQuerySubscribers',
        'transaction', 'unsubscribe', 'unsubscribeQuery', 'unsubscribeQuerySubscribers',
        // Broadcast fire-back handlers (the tier-worker dispatch path).
        'onBroadcastResult', 'onQueryBroadcastResult', 'onQuerySubscriberListBroadcastResult',
        // (No reload channel here: cb1e878 deleted the Galaxy reload fan-out — a build
        // replies to whoever asked via announceBuildToRequester; Star's channel stays.)
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
    expect(chat).toEqual(['appendWorkspaceOntology', 'buildNow', 'readSource', 'writeSource']);
  });

  it('the DOMINION list is exactly Galaxy configuration: setGalaxyConfig and ensureChat', () => {
    // A source entry accidentally shipped with requireDominionHere ENTERS this set → red;
    // a config method dropped to the chat floor LEAVES it → red.
    expect(meshMethods('dominion')).toEqual(['ensureChat', 'setGalaxyConfig']);
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

  it('onInviteResult is NOT mesh-callable — the forge-grant fence', () => {
    // The fire-back lands via __handleResponse (allowlist off); an @mesh here would let
    // any in-scope caller forge an invite outcome and write themselves grants.
    const fn = (Galaxy.prototype as unknown as Record<string, unknown>).onInviteResult;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn as (...a: unknown[]) => unknown)).toBe(false);
  });

  it('the mesh surface offers NO `chat` method at all — the commit IS the trigger', () => {
    // Phase 4 (collapse): the committed human Message triggers codegen; an invocable
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
