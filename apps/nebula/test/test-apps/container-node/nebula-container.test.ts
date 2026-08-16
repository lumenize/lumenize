/**
 * NebulaContainer structural scope-isolation (Phase 3) — mirrors
 * scope-isolation.test.ts (the NebulaDO guard), driven below the public API
 * against a harness that borrows NebulaContainer's REAL onBeforeCall +
 * recordValue/readValue (see container-node/index.ts for why a harness).
 *
 * Every test is capable-of-failing: it flips RED if the guard drops the
 * structural check. The cross-scope write test is mutation-validated by
 * commenting out the `isAtOrAbove` reject in NebulaContainer.onBeforeCall.
 *
 * @see tasks/nebula-devcontainer-node-type.md § Phase 3
 * @see apps/nebula/test/test-apps/baseline/scope-isolation.test.ts (the mirror)
 */
import { describe, it, expect } from 'vitest';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { NebulaContainer } from '../../../src/nebula-container';
import { requireDominionHere } from '../../../src/nebula-do';

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
 * LOGIC and that NebulaContainer delegates to the shared `requirePassage` (ADR-007, one audit
 * point). The end-to-end admitted write is exercised by the ui-smoke lane. Rejection lands PRE-ack
 * regardless, so this is also the honest shape post-continuation-only.
 */
function onBeforeCallAs(
  instanceName: string | undefined,
  claims?: { aud?: string; access?: { authScope?: string; scopeAdmin?: boolean } },
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
    expect(() => onBeforeCallAs(scope, { aud: scope, access: { authScope: scope } })).not.toThrow();
  });

  // Downward-dominion parity (ADR-007): a `{u}.*` admin reaches a descendant {u}.{g}.dev container
  // with no aud narrowing — the container delegates to the SAME requirePassage as NebulaDO.
  it('admits a `{u}.*` admin reaching a descendant {u}.{g}.dev container (no aud narrowing)', () => {
    const universe = crypto.randomUUID();
    expect(() => onBeforeCallAs(`${universe}.app.dev`, {
      aud: universe, access: { authScope: `${universe}`, scopeAdmin: true },
    })).not.toThrow();
  });

  // Reject cases — each a distinct branch of requirePassage (mutation-checked by the operand it
  // exercises): cross-scope (m5), a >3-segment / illegal-slug / 64-hex name (M3), the platform-name
  // sink, a missing aud, a missing callee name.
  // ⚠️ Every reject below carries a REAL `access` claim, deliberately. Passage is decided on
  // `access.authScope`, so a fixture supplying only `aud` is refused for having no claim at all —
  // it would green whatever the branch under test did, which is a test that cannot fail.
  it('m5: rejects a genuinely-minted cross-scope caller', () => {
    const foreign = uniqueDevScope();
    expect(() => onBeforeCallAs(uniqueDevScope(), { aud: foreign, access: { authScope: foreign } }))
      .toThrow('Active-scope mismatch');
  });

  it('M3: a >3-segment name fails closed (parseId rejects)', () => {
    expect(() => onBeforeCallAs('a.b.c.d', { aud: 'a.b.c.d', access: { authScope: 'a.b.c.d' } }))
      .toThrow(/dot-separated segments/);
  });

  it('M3: an illegal-slug name fails closed (parseId rejects)', () => {
    expect(() => onBeforeCallAs('Bad.app.dev', { aud: 'Bad.app.dev', access: { authScope: 'Bad.app.dev' } }))
      .toThrow(/Invalid slug/);
  });

  it('M3: a 64-hex DO-id-shaped name is rejected for a real aud', () => {
    // A 64-hex string is a valid universe-tier slug, but a real `{u}.{g}.dev` member's scope is
    // neither at nor below it → rejected. So a hex address can never reach a tenant container.
    const caller = uniqueDevScope();
    expect(() => onBeforeCallAs('a'.repeat(64), { aud: caller, access: { authScope: caller } }))
      .toThrow('Active-scope mismatch');
  });

  it('a container addressed at "nebula-platform" is rejected for a real caller', () => {
    // ⚠️ The NAME RESERVATION, not a containment refusal — and it must fire even for a caller who
    // WOULD have passage. Every scope is at or below the platform root, so a real member reaches
    // this name under the ordinary rule; the reject is what stands in front of it.
    const caller = uniqueDevScope();
    expect(() => onBeforeCallAs('nebula-platform', { aud: caller, access: { authScope: caller } }))
      .toThrow('Active-scope mismatch');
  });

  // ⚠️ RE-DERIVED from "rejects a call with no aud". That branch's `Missing active scope` throw
  // died with the `aud` read that justified it; the fail-closed property moved to the input that
  // now decides, and `hasPassageInto` returns false rather than throwing.
  it('rejects a call with no access claim', () => {
    expect(() => onBeforeCallAs(uniqueDevScope(), {})).toThrow('Active-scope mismatch');
  });

  it('rejects a call with no callee instance name', () => {
    expect(() => onBeforeCallAs(undefined, { aud: uniqueDevScope() })).toThrow('missing callee instance name');
  });

  // B1: a covering NON-admin does NOT get dominion — the gate is access.scopeAdmin, not pattern-coverage.
  // Mutation: drop `access?.scopeAdmin &&` in requirePassage → this would ADMIT → not.toThrow → RED.
  it('B1: a covering NON-admin (no access.scopeAdmin) does NOT reach the descendant container', () => {
    const universe = crypto.randomUUID();
    expect(() => onBeforeCallAs(`${universe}.app.dev`, {
      aud: universe, access: { authScope: `${universe}` /* no admin */ },
    })).toThrow('Active-scope mismatch');
  });
});

// Walk NebulaContainer's own prototype, returning its mesh-callable methods
// whose guard is NOT requireDominionHere (identity comparison). Derived dynamically so
// a newly-added non-admin @mesh method changes the set and fails the freeze.
function nonAdminMeshMethods(ctor: { prototype: object }): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (getMeshGuard(fn) === requireDominionHere) continue;
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
