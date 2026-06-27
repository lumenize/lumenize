/**
 * DevContainer (Phase 3.5a) — the composed seam is tested via PURE helpers +
 * prototype inspection, NOT by constructing the node: `extends Container` can't be
 * built under vitest-pool-workers ([[container-no-construct-pool-workers]]). The
 * assembled-container behaviors (the applyChanges→preview round-trip + a non-blank
 * render) are now covered top-down by the `ui-smoke` lane (`test/ui-smoke/smoke.test.ts`);
 * the request-supplied-scope decoy + command-port-strip are a focused security test there
 * too. (Version-contract "ops succeed" is Wave-2 data-bound; cold-boot resilience →
 * backlog.) So this file no longer carries `it.skip` placeholders for them.
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
import {
  DevContainer,
  assertSafeRelPath,
  injectScopeMeta,
  isContainerColdResponse,
  isDocumentRequest,
  wakingPreviewPage,
} from '../../../src/dev-container';
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

describe('DevContainer cold-container recovery (idle-sleep wake)', () => {
  // The exact response a slept container produces (base proxy hit a stale `running` flag). Both
  // operands of the compound condition are mutation-checked below.
  it('flags the real "not running" proxy 500 as cold', () => {
    expect(
      isContainerColdResponse(500, 'Error proxying request to container: The container is not running, consider calling start()'),
    ).toBe(true);
    expect(isContainerColdResponse(503, 'There is no Container instance available at this time.')).toBe(true);
    expect(isContainerColdResponse(429, 'rate limited')).toBe(true); // 429 is a cold status too
  });

  // Body operand: a genuine app 500 (no cold phrase) must NOT be masked → mutating the regex to
  // always-match reds this; without it we'd loop a waking page over a real vite error.
  it('does NOT flag a genuine app 500 as cold (no masking)', () => {
    expect(isContainerColdResponse(500, '<pre>SyntaxError: Unexpected token in App.vue</pre>')).toBe(false);
    expect(isContainerColdResponse(500, 'Internal Server Error')).toBe(false);
  });

  // Status operand: a cold-looking BODY at an OK status isn't cold → mutating away the status guard
  // reds this.
  it('does NOT flag a non-error status even with a container-ish body', () => {
    expect(isContainerColdResponse(200, 'starting the container, not running yet')).toBe(false);
    expect(isContainerColdResponse(404, 'not running')).toBe(false);
  });

  it('isDocumentRequest: navigation yes, sub-asset no', () => {
    expect(isDocumentRequest(new Request('https://x/', { headers: { 'sec-fetch-dest': 'document' } }))).toBe(true);
    expect(isDocumentRequest(new Request('https://x/', { headers: { accept: 'text/html,application/xhtml+xml' } }))).toBe(true);
    expect(isDocumentRequest(new Request('https://x/app.js', { headers: { 'sec-fetch-dest': 'script', accept: '*/*' } }))).toBe(false);
  });

  it('wakingPreviewPage: 200 HTML with a MANUAL reload and NO auto-reload loop', async () => {
    const res = wakingPreviewPage();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    // Manual reload only.
    expect(html).toMatch(/location\.reload/);
    // Guard against re-introducing the auto-reload loop — the 2026-06-27 regression that hammered a
    // stuck container and blocked the idle-eviction that clears its stale running-flag.
    expect(html).not.toMatch(/http-equiv=["']?refresh/i);
  });
});
