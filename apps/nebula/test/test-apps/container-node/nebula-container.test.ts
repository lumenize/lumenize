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
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import { NebulaContainer } from '../../../src/nebula-container';
import { requireAdmin } from '../../../src/nebula-do';

const HARNESS = () => (env as any).CONTAINER_GUARD_HARNESS;
// A DevContainer is always addressed by a parseId-valid `{u}.{g}.dev` star id
// (M3). uuid segments are valid slugs (hex + single hyphens).
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;

// Build a mesh envelope invoking `method(...args)` on the harness, stamping its
// instanceName from metadata.callee (so onBeforeCall derives scope from it).
function makeEnvelope(opts: {
  method: string;
  args?: any[];
  instanceName: string;
  aud?: string;
  access?: { authScopePattern: string; admin?: boolean };
}) {
  const chain = [
    { type: 'get', key: opts.method },
    { type: 'apply', args: opts.args ?? [] },
  ];
  const callContext: any = { callChain: [], state: {} };
  if (opts.aud || opts.access) {
    callContext.originAuth = { sub: 'sys', claims: { aud: opts.aud, access: opts.access } };
  }
  return {
    version: 1,
    chain: preprocess(chain),
    callContext,
    metadata: {
      callee: { type: 'LumenizeDO', bindingName: 'CONTAINER_GUARD_HARNESS', instanceName: opts.instanceName },
    },
  };
}

describe('NebulaContainer structural scope isolation', () => {
  // ── In-scope caller is accepted; its guarded write lands ──────────────────
  it('an in-scope caller passes and its @mesh write lands', async () => {
    const scope = uniqueDevScope();
    const stub = HARNESS().getByName(scope);
    const w = await stub.__executeOperation(
      makeEnvelope({ method: 'recordValue', args: ['v1'], instanceName: scope, aud: scope }),
    );
    expect(w.$error).toBeUndefined();
    const r = await stub.__executeOperation(
      makeEnvelope({ method: 'readValue', instanceName: scope, aud: scope }),
    );
    expect(r.$error).toBeUndefined();
    expect(r.$result).toBe('v1');
  });

  // ── B1/m5: a genuinely-minted cross-scope caller is rejected; write nothing ─
  // Mutation-check (RECORDED): comment out the `matchAccess` reject in
  // NebulaContainer.onBeforeCall → the cross-scope write lands → the in-scope
  // readback returns 'leak' → RED.
  it('m5: a cross-scope caller is rejected and persists nothing', async () => {
    const victim = uniqueDevScope();
    const attacker = uniqueDevScope(); // a different star scope
    const stub = HARNESS().getByName(victim);

    // Attacker (own valid aud, not forged) addresses the victim's container.
    const w = await stub.__executeOperation(
      makeEnvelope({ method: 'recordValue', args: ['leak'], instanceName: victim, aud: attacker }),
    );
    expect(postprocess(w.$error).message).toContain('Active-scope mismatch');

    // In-scope readback proves nothing was written.
    const r = await stub.__executeOperation(
      makeEnvelope({ method: 'readValue', instanceName: victim, aud: victim }),
    );
    expect(r.$error).toBeUndefined();
    expect(r.$result).toBeUndefined();
  });

  // ── M3: fail-closed on a non-parseId / wrong-shape name (mirror T-malformed) ─
  it('M3: a >3-segment name fails closed (parseId rejects)', async () => {
    const stub = HARNESS().getByName('a.b.c.d');
    const r = await stub.__executeOperation(
      makeEnvelope({ method: 'recordValue', args: ['x'], instanceName: 'a.b.c.d', aud: 'a.b.c.d' }),
    );
    expect(postprocess(r.$error).message).toContain('dot-separated segments');
  });

  it('M3: an illegal-slug name fails closed (parseId rejects)', async () => {
    const stub = HARNESS().getByName('Bad.app.dev');
    const r = await stub.__executeOperation(
      makeEnvelope({ method: 'recordValue', args: ['x'], instanceName: 'Bad.app.dev', aud: 'Bad.app.dev' }),
    );
    expect(postprocess(r.$error).message).toContain('Invalid slug');
  });

  it('M3: a 64-hex DO-id-shaped name is rejected (never addressed by idFromString)', async () => {
    // A 64-hex string is a valid universe-tier slug → buildAuthScopePattern
    // succeeds (`<hex>.*`), but a real `{u}.{g}.dev` aud is not under it → the
    // scope check rejects. So a hex address can never reach a tenant container.
    const hex = 'a'.repeat(64);
    const realScope = uniqueDevScope();
    const stub = HARNESS().getByName(hex);
    const r = await stub.__executeOperation(
      makeEnvelope({ method: 'recordValue', args: ['x'], instanceName: hex, aud: realScope }),
    );
    expect(postprocess(r.$error).message).toContain('Active-scope mismatch');
  });

  // ── Platform name is not an any-aud sink (mirror T-platform) ──────────────
  it('a container addressed at "nebula-platform" is rejected for a real aud', async () => {
    const stub = HARNESS().getByName('nebula-platform');
    const r = await stub.__executeOperation(
      makeEnvelope({ method: 'recordValue', args: ['x'], instanceName: 'nebula-platform', aud: uniqueDevScope() }),
    );
    expect(postprocess(r.$error).message).toContain('Active-scope mismatch');
  });

  // ── Fail-closed below the public API: missing aud / missing callee ────────
  it('rejects a call with no aud', async () => {
    const scope = uniqueDevScope();
    const stub = HARNESS().getByName(scope);
    const r = await stub.__executeOperation(makeEnvelope({ method: 'readValue', instanceName: scope }));
    expect(postprocess(r.$error).message).toContain('Missing active scope');
  });

  it('rejects an envelope missing metadata.callee (no instance name)', async () => {
    const scope = uniqueDevScope();
    const stub = HARNESS().getByName(scope);
    // No callee metadata → instanceName never stamped → fail closed.
    const chain = [{ type: 'get', key: 'readValue' }, { type: 'apply', args: [] }];
    const r = await stub.__executeOperation({
      version: 1,
      chain: preprocess(chain),
      callContext: { callChain: [], state: {}, originAuth: { sub: 'sys', claims: { aud: scope } } } as any,
    });
    expect(postprocess(r.$error).message).toContain('missing callee instance name');
  });

  // ── Higher-admin reach parity (the container delegates to the SAME helper) ──
  // NebulaContainer.onBeforeCall and NebulaDO.onBeforeCall both call the shared
  // enforceScopeReach (ADR-007, one audit point), so the admin-reach behavior
  // holds identically here — proven through the REAL container onBeforeCall.
  // @see tasks/nebula-onbeforecall-higher-admin-reach.md
  it('a `{u}.*` admin reaches a descendant {u}.{g}.dev container (no aud narrowing)', async () => {
    const universe = crypto.randomUUID();
    const scope = `${universe}.app.dev`;
    const stub = HARNESS().getByName(scope);
    const w = await stub.__executeOperation(makeEnvelope({
      method: 'recordValue', args: ['ok'], instanceName: scope,
      aud: universe, access: { authScopePattern: `${universe}.*`, admin: true },
    }));
    expect(w.$error).toBeUndefined();
    const r = await stub.__executeOperation(makeEnvelope({
      method: 'readValue', instanceName: scope, aud: scope,
    }));
    expect(r.$result).toBe('ok');
  });

  // B1 parity: a covering NON-admin does NOT get reach — the gate is access.admin,
  // not pattern-coverage. Mutation: drop `access?.admin &&` in enforceScopeReach
  // → the write below lands → RED.
  it('B1: a covering NON-admin (no access.admin) does NOT reach the descendant container', async () => {
    const universe = crypto.randomUUID();
    const scope = `${universe}.app.dev`;
    const stub = HARNESS().getByName(scope);
    const w = await stub.__executeOperation(makeEnvelope({
      method: 'recordValue', args: ['leak'], instanceName: scope,
      aud: universe, access: { authScopePattern: `${universe}.*` /* no admin */ },
    }));
    expect(postprocess(w.$error).message).toContain('Active-scope mismatch');
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
