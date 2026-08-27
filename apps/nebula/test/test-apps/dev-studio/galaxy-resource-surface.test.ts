/**
 * Galaxy @mesh surface + resource facet (the `dev-studio` project — its name predates
 * the collapse of DevStudio into Galaxy).
 *
 * Two things, neither needing a Gateway/client:
 *  1. **Frozen @mesh surface (m5):** the resource methods are non-admin (`@mesh()`,
 *     DAG-gated); codegen/source methods stay `requireDominionHere`; and the invite
 *     RESULT handler is not mesh-callable at all (the forge-grant fence).
 *  2. **Facet behavior on Galaxy:** the composed Session/Message provider mounts +
 *     enforces the ADR-006 embed-guard (SC3), coexists with the tool-args facet in
 *     one DO without bundleId cross-wiring (M2), and survives an `onStart` re-init
 *     with an unchanged version (M3).
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { Galaxy } from '../../../src/galaxy';
import { requireDominionHere } from '../../../src/nebula-do';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '../../../src/chat-constants';

// ─── driver — direct in-DO call ────────────────────────────────────────────
// These `*ForTest` methods are PURE (they read `this.ctx`/`this.env.LOADER`, no callContext, no
// cross-DO call), so run them directly in-DO to get the RETURN VALUE. Driving them through the mesh
// `__executeOperation` path is no longer usable here: it EARLY-ACKS (returns `{$ack}`) and runs the
// chain in a detached `waitUntil` task, so the result would travel via fire-back, unobservable from
// a bare envelope. The admin `@mesh(requireDominionHere)` guard is not what these facet-behavior tests
// exercise (the m5/requireDominionHere *surface* is frozen statically above), so bypassing it is correct.
const uniqueGalaxyScope = () => `${crypto.randomUUID()}.app`;
async function callGalaxy(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).GALAXY.getByName(instance);
  return (runInDurableObject as any)(stub, (inst: any) => inst[method](...args));
}

// Walk Galaxy's OWN prototype for mesh-callable methods, partitioned by guard.
function meshMethods(admin: boolean): string[] {
  const proto = Galaxy.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if ((getMeshGuard(fn) === requireDominionHere) === admin) out.push(name);
  }
  return out.sort();
}

describe('Galaxy @mesh surface freeze (m5)', () => {
  // Freeze the non-admin surface: a resource method accidentally shipped with
  // requireDominionHere LEAVES this set (→ red); a codegen method accidentally shipped
  // non-admin ENTERS it (→ red). Both gate sets are thus pinned.
  it('non-admin @mesh surface == the resource + registry-read surface, exactly', () => {
    expect(meshMethods(false)).toEqual(
      [
        // Ontology-registry reads — passage-gated only; getOntologyVersion is the
        // Star's UPWARD lazy-pull target (every member of a descendant scope reaches it).
        'getGalaxyConfig', 'getLatestOntologyVersion', 'getOntologyVersion', 'listOntologyVersions',
        // The DagTree gate + the invite ENTRY (DAG-gated per-op inside the plane).
        'dagTree', 'invite',
        // The resource data-plane surface — chat participants are non-admin but DAG-granted.
        'read', 'subscribe', 'subscribeQuery', 'subscribeQuerySubscribers',
        'transaction', 'unsubscribe', 'unsubscribeQuery', 'unsubscribeQuerySubscribers',
        // Broadcast fire-back handlers (the tier-worker dispatch path).
        'onBroadcastResult', 'onQueryBroadcastResult', 'onQuerySubscriberListBroadcastResult',
        // Phase 3: the build-completion reload channel — registration is passage-gated
        // (any chat participant re-registers on reconnect, like subscribeTree); the
        // fire-back handler rides broadcast.
        'subscribeReload', 'onReloadBroadcastResult',
      ].sort(),
    );
  });

  it('codegen/source + registry-write methods stay requireDominionHere', () => {
    const admin = meshMethods(true);
    for (const m of [
      'writeSource', 'readSource', 'appendWorkspaceOntology',
      'chat', 'warmPreview', 'ensureChat', 'buildNow',
      'appendOntologyVersion', 'setGalaxyConfig',
    ]) {
      expect(admin).toContain(m);
    }
  });

  it('onInviteResult is NOT mesh-callable — the forge-grant fence', () => {
    // The fire-back lands via __handleResponse (allowlist off); an @mesh here would let
    // any in-scope caller forge an invite outcome and write themselves grants.
    const fn = (Galaxy.prototype as unknown as Record<string, unknown>).onInviteResult;
    expect(typeof fn).toBe('function');
    expect(isMeshCallable(fn as (...a: unknown[]) => unknown)).toBe(false);
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
