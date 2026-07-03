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
  // ── M4: an inbound mesh call lands via __executeOperation and runs (early-ack) ──
  it('M4: an inbound lmz.call lands via __executeOperation, acks early, and runs', async () => {
    const name = uniqueName();
    const stub = SEAM().getByName(name);
    // Early ack (D15): __executeOperation returns {$ack}; the chain runs post-ack.
    const ack = await stub.__executeOperation(makeEnvelope({ method: 'echo', args: ['hi'], instanceName: name }));
    expect(ack).toEqual({ $ack: true });
    await vi.waitFor(async () => {
      expect(await stub.getLastEcho()).toBe('seam:hi');
    });
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
  // In the early-ack model the @mesh gate runs post-ack (inside executeOperationChain), so a
  // non-@mesh method admits ({$ack}) then throws in the chain — surfaced via the debug sink.
  // Mutation-check (RECORDED): change __executeOperation's requireMeshDecorator to false → the
  // call lands, no post-ack throw → RED. Guards against wiring the bypass onto inbound dispatch.
  it('@mesh: a mesh call to a non-@mesh method is rejected (post-ack, logged)', async () => {
    const name = uniqueName();
    const entries: Array<{ message?: string; data?: { error?: string } }> = [];
    setDebugSink((e) => entries.push(e as any));
    try {
      const stub = SEAM().getByName(name);
      const ack = await stub.__executeOperation(makeEnvelope({ method: 'plainMethod', instanceName: name }));
      expect(ack).toEqual({ $ack: true });
      await vi.waitFor(() => {
        const rejected = entries.some(
          (e) => e.message?.includes('post-ack chain threw') && e.data?.error?.includes('not mesh-callable'),
        );
        expect(rejected).toBe(true);
      });
    } finally {
      clearDebugSink();
    }
  });

  // ── m9 / ADR-002: a thrown Error is caught + surfaced (not a crash) on the seam ──
  // In the early-ack model the throw rides the post-ack path (logged for a 3-arg call, or the
  // fire-back for a 4-arg call). The full custom-Error name+own-props {$error} round-trip is
  // covered by the mesh main error tests + @lumenize/structured-clone; here we verify the seam
  // catches + surfaces the throw without crashing the node.
  it('m9: a @mesh method throwing an Error is caught + surfaced on the seam (post-ack)', async () => {
    const name = uniqueName();
    const entries: Array<{ message?: string; data?: { error?: string } }> = [];
    setDebugSink((e) => entries.push(e as any));
    try {
      const stub = SEAM().getByName(name);
      const ack = await stub.__executeOperation(makeEnvelope({ method: 'boom', instanceName: name }));
      expect(ack).toEqual({ $ack: true });
      await vi.waitFor(() => {
        const surfaced = entries.some(
          (e) => e.message?.includes('post-ack chain threw') && e.data?.error?.includes('kaboom from container node'),
        );
        expect(surfaced).toBe(true);
      });
    } finally {
      clearDebugSink();
    }
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
