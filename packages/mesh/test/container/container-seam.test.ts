/**
 * LumenizeContainer composed-seam tests (Phase 2).
 *
 * The Phase-2 precheck proved a `class X extends Container {}` can't be
 * constructed under vitest-pool-workers (no container engine → `ctx.container`
 * undefined → base constructor throws). So the receive contract is verified
 * here against `MeshContainerSeamHarness` — a non-`Container` DO that composes
 * the IDENTICAL recipe (`createLmzApiForDO` + `executeEnvelope` +
 * `executeOperationChain`) `LumenizeContainer` uses. The literal class's
 * prototype wiring + `fetch()` pin are locked by container-prototype.test.ts.
 *
 * Every assertion is capable-of-failing; the mutation that flips each RED is
 * named in its comment (recorded in tasks/nebula-devcontainer-node-type.md).
 *
 * @see tasks/nebula-devcontainer-node-type.md § Phase 2
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugSink } from '@lumenize/debug';

const SEAM = () => (env as any).SEAM_HARNESS;
const uniqueName = () => `seam-${crypto.randomUUID()}`;

// Build a mesh envelope that invokes `method(...args)` on the harness, stamping
// its identity from metadata.callee (so outgoing calls have a bindingName).
function makeEnvelope(opts: { method: string; args?: any[]; instanceName: string }) {
  const chain = [
    { type: 'get', key: opts.method },
    { type: 'apply', args: opts.args ?? [] },
  ];
  return {
    version: 1,
    chain: preprocess(chain),
    callContext: { callChain: [], state: {} } as any,
    metadata: {
      callee: { type: 'LumenizeDO', bindingName: 'SEAM_HARNESS', instanceName: opts.instanceName },
    },
  };
}

describe('LumenizeContainer composed seam (via MeshContainerSeamHarness)', () => {
  // ── M4: an inbound mesh call lands via __executeOperation and returns ──────
  it('M4: an inbound lmz.call lands via __executeOperation and returns a value', async () => {
    const name = uniqueName();
    const stub = SEAM().getByName(name);
    const r = await stub.__executeOperation(makeEnvelope({ method: 'echo', args: ['hi'], instanceName: name }));
    expect(r.$error).toBeUndefined();
    expect(r.$result).toBe('seam:hi');
  });

  // ── m8: onBeforeCall fires on the inbound mesh path ───────────────────────
  // Mutation-check (RECORDED): comment out `node.onBeforeCall()` in
  // executeEnvelope (lmz-api.ts) → this marker-count assertion goes RED.
  it('m8: onBeforeCall fires once on an inbound mesh call', async () => {
    const name = uniqueName();
    const entries: Array<{ namespace: string; data?: { instanceName?: string } }> = [];
    const sink: DebugSink = (e) => entries.push(e as any);
    setDebugSink(sink);
    try {
      const stub = SEAM().getByName(name);
      await stub.__executeOperation(makeEnvelope({ method: 'echo', args: ['x'], instanceName: name }));
      const fired = entries.filter(
        (e) => e.namespace === 'lmz.mesh.test.SeamHarness.onBeforeCall' && e.data?.instanceName === name,
      );
      expect(fired).toHaveLength(1);
    } finally {
      clearDebugSink();
    }
  });

  // ── @mesh enforcement: a plain (non-@mesh) method is rejected ─────────────
  // Mutation-check (RECORDED): flip the harness __executeChain to
  // `requireMeshDecorator: false` → the call lands → RED. Guards against wiring
  // the bypass executor onto inbound dispatch (silently exposes every method).
  it('@mesh: a mesh call to a non-@mesh method is rejected', async () => {
    const name = uniqueName();
    const stub = SEAM().getByName(name);
    const r = await stub.__executeOperation(makeEnvelope({ method: 'plainMethod', instanceName: name }));
    expect(r.$result).toBeUndefined();
    expect(r.$error).toBeDefined();
    expect(postprocess(r.$error).message).toContain('not mesh-callable');
  });

  // ── m9 / ADR-002: a thrown custom Error round-trips with name + own props ──
  it('m9: a @mesh method throwing a custom Error round-trips name + custom property', async () => {
    const name = uniqueName();
    const stub = SEAM().getByName(name);
    const r = await stub.__executeOperation(makeEnvelope({ method: 'boom', instanceName: name }));
    expect(r.$error).toBeDefined();
    const err = postprocess(r.$error) as Error & { code?: string };
    // Assert by name + property presence, NOT instanceof (mesh.md).
    expect(err.name).toBe('SeamCustomError');
    expect(err.message).toContain('kaboom from container node');
    expect(err.code).toBe('SEAM_X');
  });

  // ── m2 (testable half): identity stamps into ctx.storage.kv on first inbound ─
  // Proves the lazy `lmz` getter persists __lmz_do_* after the base lifecycle,
  // composed via createLmzApiForDO. (The Container-specific coexistence with
  // `container_schedules` is deferred below.)
  it('m2: one inbound mesh call stamps bindingName + instanceName into kv', async () => {
    const name = uniqueName();
    const stub = SEAM().getByName(name);
    await stub.__executeOperation(makeEnvelope({ method: 'echo', args: ['x'], instanceName: name }));
    const id = await stub.getStampedIdentity();
    expect(id).toEqual({ bindingName: 'SEAM_HARNESS', instanceName: name });
  });

  // ── M4 outgoing: after an inbound call stamps identity, lmz.ctn fires ──────
  it('M4: an outgoing lmz.ctn to a sibling lands after identity is stamped', async () => {
    const a = uniqueName();
    const b = uniqueName();
    const stubA = SEAM().getByName(a);
    // Inbound to A stamps A's binding name → its outgoing call is permitted.
    await stubA.__executeOperation(
      makeEnvelope({ method: 'pingOther', args: [b, 'hello-b'], instanceName: a }),
    );
    const stubB = SEAM().getByName(b);
    await vi.waitFor(async () => {
      expect(await stubB.getLastPing()).toBe('hello-b');
    });
  });

  // ── M4 outgoing negative micro-check: outgoing before any inbound throws ───
  it('M4: an outgoing ctn on a never-called instance throws "binding name"', async () => {
    const stub = SEAM().getByName(uniqueName());
    // Direct RPC (NOT via executeEnvelope) → identity never stamped → throws.
    await expect(stub.tryOutgoingWithoutInit()).rejects.toThrow(/binding name/i);
  });

  // ── m2 (Container-specific half) — deferred to a deployed e2e ──────────────
  // The full lifecycle-coexistence assertion (Lumenize identity kv AND
  // Container's `container_schedules` table AND the alarm slot all intact after
  // one inbound call) requires a REAL `Container` instance. The precheck proved
  // that can't be constructed under pool-workers, so this runs only against a
  // deployed `LumenizeContainer`/`NebulaContainer` (DevContainer e2e, #1a).
  it.skip('m2 (assembled): identity kv + container_schedules + alarm slot coexist after first inbound — needs a live Container (deployed e2e, #1a)', () => {
    // Blocked on: deployed-container harness. The composable half (identity kv
    // stamping via the lazy lmz getter) is covered by the m2 test above.
  });
});
