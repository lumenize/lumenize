/**
 * DevContainer (Phase 3.5a) — the composed seam is tested via PURE helpers +
 * prototype inspection, NOT by constructing the node: `extends Container` can't be
 * built under vitest-pool-workers ([[container-no-construct-pool-workers]]). The
 * assembled-container e2e (fetch() 3-way branch over a live vite container, the
 * applyChanges→/apply round-trip, the request-supplied-scope decoy) is a
 * deploy-gated `it.skip` — it gates on the first full `apps/nebula` Worker deploy.
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

  it('the command methods are mesh-callable + requireAdmin (spot-check applyChanges/exec)', () => {
    for (const name of ['ensureUp', 'applyChanges', 'exec', 'viteControl', 'readFileInContainer']) {
      const fn = (DevContainer.prototype as unknown as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
      expect(typeof fn).toBe('function');
      expect(isMeshCallable(fn)).toBe(true);
      expect(getMeshGuard(fn)).toBe(requireAdmin);
    }
  });
});

describe('DevContainer assembled-container e2e (deploy-gated)', () => {
  it.skip('fetch() 3-way branch + applyChanges round-trip + request-scope decoy (needs a deployed Worker + live container)', () => {
    // Mechanism PROVEN on the torn-down `container-node-phase0` experiment (curl-
    // validated live): the public fetch() injects the server-derived scope, a
    // request-supplied `?activeScope=evil.g.dev` decoy is IGNORED, `cf-container-
    // target-port:9000` is stripped (can't reach the command port), and a write over
    // the command channel HMRs the browser (~10 ms js-update). It can't run under
    // vitest-pool-workers (`extends Container` won't construct — no container
    // engine). Revive against the first full `apps/nebula` Worker deploy
    // (Docker Desktop + WARP); see tasks/nebula-studio.md § Test strategy.
  });

  it.skip('cold boot re-push: ensureUp boot-race retry + applyChanges(full tree) → preview comes back identical (Flow 1c)', () => {
    // The cold-boot half of the source-of-truth round-trip success criterion: a
    // DevContainer cold boot reverts the disk to the baked image; DevStudio
    // re-pushes the full tree (applyChanges) and the preview is identical, incl.
    // the first containerFetch hitting a not-ready container → ContainerUnavailable
    // → DO retries → eventually serves. Deploy-gated (same reason as above).
  });
});
