/**
 * DevStudio resource data-plane surface (Child 1, nebula-devstudio-data-plane.md Phase 3).
 *
 * Two things, neither needing a Gateway/client (the real client resource round-trip
 * + the non-admin-DAG-granted read/write + version-stamp are Phase 5):
 *  1. **Frozen @mesh surface (m5):** the new resource methods are non-admin
 *     (`@mesh()`, DAG-gated — D4); codegen/source methods stay `requireAdmin`.
 *  2. **Facet behavior on DevStudio:** the composed Session/Turn provider mounts +
 *     enforces the ADR-006 embed-guard (SC3), coexists with the tool-args facet in
 *     one DO without bundleId cross-wiring (M2), and survives an `onStart` re-init
 *     with an unchanged version (M3).
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { DevStudio } from '../../../src/dev-studio';
import { requireAdmin } from '../../../src/nebula-do';
import { SESSION_TURN_ONTOLOGY_VERSION } from '../../../src/devstudio-resource-ontology';

// ─── envelope driver (no Gateway/JWT — same pattern as dev-studio.test.ts) ───
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;
function envelope(instanceName: string, method: string, args: unknown[] = []) {
  return {
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
    callContext: { callChain: [], state: {}, originAuth: { sub: 'admin', claims: { aud: instanceName, access: { admin: true } } } } as any,
    metadata: { callee: { type: 'LumenizeDO', bindingName: 'DEV_STUDIO', instanceName } },
  };
}
async function callStudio(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).DEV_STUDIO.getByName(instance);
  const r = await stub.__executeOperation(envelope(instance, method, args));
  if (r?.$error) throw postprocess(r.$error);
  return r?.$result;
}

// Walk DevStudio's OWN prototype for mesh-callable methods, partitioned by guard.
function meshMethods(admin: boolean): string[] {
  const proto = DevStudio.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if ((getMeshGuard(fn) === requireAdmin) === admin) out.push(name);
  }
  return out.sort();
}

describe('DevStudio @mesh surface freeze (m5)', () => {
  // Freeze the non-admin surface: a resource method accidentally shipped with
  // requireAdmin LEAVES this set (→ red); a codegen method accidentally shipped
  // non-admin ENTERS it (→ red). Both gate sets are thus pinned.
  it('non-admin @mesh surface == the resource surface, exactly', () => {
    expect(meshMethods(false)).toEqual(
      ['dagTree', 'onBroadcastResult', 'read', 'subscribe', 'transaction', 'unsubscribe'],
    );
  });

  it('codegen/source methods stay requireAdmin', () => {
    const admin = meshMethods(true);
    for (const m of [
      'writeSource', 'readSource', 'getSourceTree',
      'compileAndInstallOntology', 'applyOntologyChange',
      'ensureUp', 'syncToDevContainer', 'chat', 'warmPreview',
    ]) {
      expect(admin).toContain(m);
    }
  });
});

describe('DevStudio Session/Turn facet (composed provider)', () => {
  const validTurn = { session: 'sess-1', role: 'user', content: 'hello' };

  it('SC3 + M2: accepts a Turn whose session is an id string (both facets mounted → no cross-wiring)', async () => {
    const dev = uniqueDevScope();
    const r = await callStudio(dev, 'parseSessionTurnForTest', ['Turn', validTurn]);
    expect(r.valid).toBe(true);
  });

  it('SC3: rejects an embedded session object with the ADR-006 by-id (embed) guard', async () => {
    const dev = uniqueDevScope();
    const embedded = { session: { title: 'embedded not an id' }, role: 'user', content: 'x' };
    const r = await callStudio(dev, 'parseSessionTurnForTest', ['Turn', embedded]);
    expect(r.valid).toBe(false);
    const err = r.errors.find((e: { path: string }) => e.path === '$input.session');
    expect(err).toBeDefined();
    // The loud warning explains the by-id relationship contract (names field + target).
    expect(err.description).toMatch(/reference by id/i);
  });

  it('M3: ontology version is the fixed constant and survives an onStart re-init', async () => {
    const dev = uniqueDevScope();
    expect(await callStudio(dev, 'resourceOntologyVersionForTest')).toBe(SESSION_TURN_ONTOLOGY_VERSION);
    await callStudio(dev, 'reInitForTest');
    // Re-derivable from the platform constant — a write still validates, version unchanged.
    const r = await callStudio(dev, 'parseSessionTurnForTest', ['Turn', validTurn]);
    expect(r.valid).toBe(true);
    expect(await callStudio(dev, 'resourceOntologyVersionForTest')).toBe(SESSION_TURN_ONTOLOGY_VERSION);
  });
});
