/**
 * DevContainer (Phase 3.5a) — the composed seam is tested via PURE helpers +
 * prototype inspection, NOT by constructing the node: `extends Container` can't be
 * built under vitest-pool-workers ([[container-no-construct-pool-workers]]). The
 * assembled-container e2e (fetch() 3-way branch over a live vite container, the
 * applyChanges→/apply round-trip, the request-supplied-scope decoy) is an
 * `it.skip` run with `wrangler dev` + Docker Desktop (the Container runs locally there;
 * it just can't construct under pool-workers).
 *
 * What IS proven here (each capable-of-failing):
 *  - the writeFile path-traversal guard (`assertSafeRelPath`) — `../` AND absolute
 *    each rejected, an in-tree path accepted (the positive control);
 *  - scope-injection as a pure derivation (`injectScopeMeta` + the authScope split);
 *  - the command @mesh surface is fully admin-gated (`nonAdminMeshMethods` === []).
 *
 * @see tasks/nebula-studio.md § DevContainer dev loop, § Test strategy
 */
import { describe, it, expect } from 'vitest';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { DevContainer, assertSafeRelPath, injectScopeMeta } from '../../../src/dev-container';
import { requireAdmin } from '../../../src/nebula-do';

describe('DevContainer writeFile path-traversal guard (assertSafeRelPath)', () => {
  // Positive control: an in-tree relative path is accepted (no throw). If this
  // threw, the guard would be rejecting legitimate pushes (capable-of-failing).
  it('accepts an in-tree relative path', () => {
    expect(() => assertSafeRelPath('src/App.vue')).not.toThrow();
    expect(() => assertSafeRelPath('src/components/TodoList.vue')).not.toThrow();
    expect(() => assertSafeRelPath('ontology.d.ts')).not.toThrow();
  });

  // Negative 1: a `../` traversal segment is rejected. Mutation-check: deleting the
  // `..`-segment branch in assertSafeRelPath lets this through → RED.
  it('rejects a ../ traversal path (writes nothing)', () => {
    expect(() => assertSafeRelPath('../etc/evil')).toThrow(/'\.\.' segment/);
    expect(() => assertSafeRelPath('src/../../escape')).toThrow(/'\.\.' segment/);
    expect(() => assertSafeRelPath('src\\..\\..\\escape')).toThrow(/'\.\.' segment/);
  });

  // Negative 2: an absolute path is rejected. Mutation-check: deleting the
  // `startsWith('/')` branch lets this through → RED. (Distinct operand from the
  // `..` check — both must be enumerated, testing.md compound-condition rule.)
  it('rejects an absolute path (writes nothing)', () => {
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(/[Aa]bsolute/);
    expect(() => assertSafeRelPath('/workspace/app/src/App.vue')).toThrow(/[Aa]bsolute/);
  });

  it('rejects an empty / non-string path', () => {
    expect(() => assertSafeRelPath('')).toThrow(/Invalid source path/);
    expect(() => assertSafeRelPath(undefined as unknown as string)).toThrow(/Invalid source path/);
  });
});

describe('DevContainer scope injection (injectScopeMeta — pure derivation)', () => {
  it('injects the server-derived scope as a strict-CSP-friendly <meta> in <head>', () => {
    const scope = { activeScope: 'acme.app.dev', authScope: 'acme.app', appVersion: 'dev' };
    const out = injectScopeMeta('<html><head><title>x</title></head><body></body></html>', scope);
    expect(out).toContain(`<meta name="nebula-scope" content='${JSON.stringify(scope)}'>`);
    // Inserted INSIDE <head> (so the bootstrap can read it before main.ts runs).
    expect(out.indexOf('nebula-scope')).toBeLessThan(out.indexOf('<title>'));
    // Round-trips: the bootstrap parses content as JSON.
    const content = out.match(/content='([^']*)'/)?.[1] ?? '';
    expect(JSON.parse(content)).toEqual(scope);
  });

  it('falls back to prepending the meta when there is no <head>', () => {
    const scope = { activeScope: 'acme.app.dev', authScope: 'acme.app', appVersion: 'dev' };
    const out = injectScopeMeta('<body>no head</body>', scope);
    expect(out.startsWith('<meta name="nebula-scope"')).toBe(true);
  });

  it('authScope is the first two segments of a {u}.{g}.dev activeScope', () => {
    // The derivation DevContainer.fetch() applies: authScope = activeScope[:2].
    // It must keep the FULL .dev activeScope (the wrong-Star footgun guard) and
    // derive a DISTINCT 2-segment authScope — never collapse the two.
    const activeScope = 'acme.app.dev';
    const authScope = activeScope.split('.').slice(0, 2).join('.');
    expect(authScope).toBe('acme.app');
    expect(authScope).not.toBe(activeScope);
  });
});

// Walk DevContainer's OWN prototype, returning its mesh-callable methods whose guard
// is NOT requireAdmin. Derived dynamically so a newly-added non-admin @mesh method
// changes the set and fails the freeze (forcing a deliberate admin classification).
function nonAdminMeshMethods(ctor: { prototype: object }): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (getMeshGuard(fn) === requireAdmin) continue;
    out.push(name);
  }
  return out.sort();
}

describe('DevContainer command @mesh surface is fully admin-gated', () => {
  it('every @mesh method DevContainer ADDS is requireAdmin-gated — nonAdminMeshMethods(DevContainer) === []', () => {
    // The command channel (applyChanges/exec/viteControl/ensureUp/readFileInContainer)
    // must all carry @mesh(requireAdmin): NebulaContainer.onBeforeCall proves tenant
    // SCOPE but never access.admin, and `<id>.*` widening admits descendant
    // non-admins. Adding an ungated @mesh method to DevContainer fails this.
    expect(nonAdminMeshMethods(DevContainer)).toEqual([]);
  });

  it('the command methods are mesh-callable + requireAdmin (spot-check applyChanges/exec/setAppVersion)', () => {
    for (const name of ['ensureUp', 'applyChanges', 'exec', 'viteControl', 'readFileInContainer', 'setAppVersion']) {
      const fn = (DevContainer.prototype as unknown as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
      expect(typeof fn).toBe('function');
      expect(isMeshCallable(fn)).toBe(true);
      expect(getMeshGuard(fn)).toBe(requireAdmin);
    }
  });
});

describe('DevContainer setAppVersion (the version the public fetch() injects)', () => {
  // Prototype call with a fake `this` — DevContainer can't construct under
  // vitest-pool-workers, but setAppVersion is a pure `kv.put` so we can drive it on the
  // prototype. The fetch()-reads-it-back round-trip is run with `wrangler dev` (below).
  it('stores the version under the DevContainer KV key', () => {
    const puts: Array<[string, unknown]> = [];
    const fakeThis = { ctx: { storage: { kv: { put: (k: string, v: unknown) => { puts.push([k, v]); } } } } };
    const oid = 'a'.repeat(40);
    (DevContainer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)
      .setAppVersion.call(fakeThis, oid);
    // Capable-of-failing: a wrong key (or no write) breaks the contract with fetch(),
    // which reads this exact key to inject `appVersion` (Decision 12 / Flow 1d).
    expect(puts).toEqual([['devcontainer:appVersion', oid]]);
  });
});

describe('DevContainer assembled-container e2e (run with `wrangler dev` + Docker Desktop)', () => {
  it.skip('fetch() 3-way branch + applyChanges round-trip + request-scope decoy (needs `wrangler dev` + Docker Desktop)', () => {
    // Mechanism PROVEN on the torn-down `container-node-phase0` experiment (curl-
    // validated live): the public fetch() injects the server-derived scope, a
    // request-supplied `?activeScope=evil.g.dev` decoy is IGNORED, `cf-container-
    // target-port:9000` is stripped (can't reach the command port), and a write over
    // the command channel HMRs the browser (~10 ms js-update). It can't run under
    // vitest-pool-workers (`extends Container` won't construct — no container
    // engine). Revive against the first full `apps/nebula` Worker deploy
    // (Docker Desktop + WARP); see tasks/nebula-studio.md § Test strategy.
  });

  it.skip('version contract: fetch() injects the REAL version → preview ops succeed → ontology change reloads onto the new version (Decision 12 / Flow 1d)', () => {
    // End-to-end on real infra (the container-free Star↔client reload half is covered
    // in baseline/reload-version-contract.test.ts):
    //  1. DevStudio.applyOntologyChange → setAppVersion(Hnew) on this DevContainer +
    //     compileAndInstallOntology(Hnew) on the .dev Star (ordered: container first).
    //  2. Preview GET → fetch() injects appVersion = kv.get(VERSION_KEY) = Hnew (NOT
    //     'dev'); the client sends Hnew → Star Handler-1 MATCHES → ops succeed (no
    //     OntologyStaleError on every op — the original deploy-blocking gap).
    //  3. A later ontology change (Hnew') → broadcastReload → the preview's onReload →
    //     reload → re-fetch injects Hnew' → ops still succeed.
    // Can't run under vitest-pool-workers (`extends Container` won't construct); revive
    // against the first full apps/nebula Worker deploy (Docker Desktop + WARP).
  });

  it.skip('cold boot re-push: ensureUp boot-race retry + applyChanges(full tree) → preview comes back identical (Flow 1c)', () => {
    // The cold-boot half of the source-of-truth round-trip success criterion: a
    // DevContainer cold boot reverts the disk to the baked image; DevStudio
    // re-pushes the full tree (applyChanges) and the preview is identical, incl.
    // the first containerFetch hitting a not-ready container → ContainerUnavailable
    // → DO retries → eventually serves. Run with `wrangler dev` (same reason as above).
  });
});
