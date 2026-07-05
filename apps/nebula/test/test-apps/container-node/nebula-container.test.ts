/**
 * NebulaContainer structural scope-isolation (Phase 3) — mirrors
 * scope-isolation.test.ts (the NebulaDO guard), driven below the public API
 * against a harness that borrows NebulaContainer's REAL onBeforeCall +
 * recordValue/readValue (see container-node/index.ts for why a harness).
 *
 * Every test is capable-of-failing: it flips RED if the guard drops the
 * structural check. The cross-scope write test is mutation-validated by
 * commenting out the `matchAccess` reject in NebulaContainer.onBeforeCall.
 *
 * @see tasks/nebula-devcontainer-node-type.md § Phase 3
 * @see apps/nebula/test/test-apps/baseline/scope-isolation.test.ts (the mirror)
 */
import { describe, it, expect } from 'vitest';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { NebulaContainer } from '../../../src/nebula-container';
import { requireAdmin } from '../../../src/nebula-do';

// A DevContainer is always addressed by a parseId-valid `{u}.{g}.dev` star id (M3). uuid segments
// are valid slugs (hex + single hyphens).
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;

/**
 * Drive the REAL `NebulaContainer.onBeforeCall` — the guard `executeEnvelope` invokes at admission —
 * on a fake `this` (server-derived identity + verified claims). PURE: no mesh dispatch, no early-ack,
 * no harness DO. A cross-scope / non-admin / malformed caller throws; a valid one returns.
 *
 * The framework's job — stamping `instanceName` from the envelope's `metadata.callee` and invoking
 * this guard at admission — is covered in `@lumenize/mesh`; here we test the structural-isolation
 * LOGIC and that NebulaContainer delegates to the shared `enforceScopeReach` (ADR-007, one audit
 * point). The end-to-end admitted write is exercised by the ui-smoke lane. Rejection lands PRE-ack
 * regardless, so this is also the honest shape post-continuation-only.
 */
function onBeforeCallAs(
  instanceName: string | undefined,
  claims?: { aud?: string; access?: { authScopePattern?: string; admin?: boolean } },
): void {
  const fakeThis = {
    lmz: { instanceName, callContext: { originAuth: claims ? { sub: 'sys', claims } : undefined } },
  };
  NebulaContainer.prototype.onBeforeCall.call(fakeThis as any);
}

describe('NebulaContainer structural scope isolation (onBeforeCall)', () => {
  // Positive controls — the guard ADMITS a valid caller (doesn't over-reject). Without these the
  // reject cases could pass vacuously against an always-reject guard.
  it('admits an in-scope caller', () => {
    const scope = uniqueDevScope();
    expect(() => onBeforeCallAs(scope, { aud: scope })).not.toThrow();
  });

  // Higher-admin reach parity (ADR-007): a `{u}.*` admin reaches a descendant {u}.{g}.dev container
  // with no aud narrowing — the container delegates to the SAME enforceScopeReach as NebulaDO.
  it('admits a `{u}.*` admin reaching a descendant {u}.{g}.dev container (no aud narrowing)', () => {
    const universe = crypto.randomUUID();
    expect(() => onBeforeCallAs(`${universe}.app.dev`, {
      aud: universe, access: { authScopePattern: `${universe}.*`, admin: true },
    })).not.toThrow();
  });

  // Reject cases — each a distinct branch of enforceScopeReach (mutation-checked by the operand it
  // exercises): cross-scope (m5), a >3-segment / illegal-slug / 64-hex name (M3), the platform-name
  // sink, a missing aud, a missing callee name.
  it('m5: rejects a genuinely-minted cross-scope caller', () => {
    expect(() => onBeforeCallAs(uniqueDevScope(), { aud: uniqueDevScope() })).toThrow('Active-scope mismatch');
  });

  it('M3: a >3-segment name fails closed (parseId rejects)', () => {
    expect(() => onBeforeCallAs('a.b.c.d', { aud: 'a.b.c.d' })).toThrow(/dot-separated segments/);
  });

  it('M3: an illegal-slug name fails closed (parseId rejects)', () => {
    expect(() => onBeforeCallAs('Bad.app.dev', { aud: 'Bad.app.dev' })).toThrow(/Invalid slug/);
  });

  it('M3: a 64-hex DO-id-shaped name is rejected for a real aud', () => {
    // A 64-hex string is a valid universe-tier slug (`<hex>.*`), but a real `{u}.{g}.dev` aud isn't
    // under it → rejected. So a hex address can never reach a tenant container.
    expect(() => onBeforeCallAs('a'.repeat(64), { aud: uniqueDevScope() })).toThrow('Active-scope mismatch');
  });

  it('a container addressed at "nebula-platform" is rejected for a real aud', () => {
    expect(() => onBeforeCallAs('nebula-platform', { aud: uniqueDevScope() })).toThrow('Active-scope mismatch');
  });

  it('rejects a call with no aud', () => {
    expect(() => onBeforeCallAs(uniqueDevScope(), {})).toThrow('Missing active scope');
  });

  it('rejects a call with no callee instance name', () => {
    expect(() => onBeforeCallAs(undefined, { aud: uniqueDevScope() })).toThrow('missing callee instance name');
  });

  // B1: a covering NON-admin does NOT get reach — the gate is access.admin, not pattern-coverage.
  // Mutation: drop `access?.admin &&` in enforceScopeReach → this would ADMIT → not.toThrow → RED.
  it('B1: a covering NON-admin (no access.admin) does NOT reach the descendant container', () => {
    const universe = crypto.randomUUID();
    expect(() => onBeforeCallAs(`${universe}.app.dev`, {
      aud: universe, access: { authScopePattern: `${universe}.*` /* no admin */ },
    })).toThrow('Active-scope mismatch');
  });
});

// Walk NebulaContainer's own prototype, returning its mesh-callable methods
// whose guard is NOT requireAdmin (identity comparison). Derived dynamically so
// a newly-added non-admin @mesh method changes the set and fails the freeze.
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

describe('NebulaContainer frozen non-admin @mesh surface (B5)', () => {
  // Freeze the non-admin @mesh surface so a new non-admin method must be added
  // deliberately (and re-reviewed against the scope-isolation invariant).
  it('B5: non-admin @mesh surface equals the frozen allow-list', () => {
    expect(nonAdminMeshMethods(NebulaContainer)).toEqual(['readValue', 'recordValue']);
  });
});
