/**
 * DevStudio node (Phase 3.5b) — the source-of-truth + compile-and-apply mechanism.
 *
 * Driven via `__executeOperation` envelopes (no Gateway/JWT) carrying an admin claim
 * at the `{u}.{g}.dev` scope, so the real receive seam runs (onBeforeCall scope guard
 * + requireAdmin). Proves:
 *  - **source-of-truth round-trip** (the "testable now" half of success criterion #3):
 *    `writeSource` commits to the shell Workspace (distinct git oids), `readSource`
 *    returns the latest, `getSourceTree` returns the tracked tree + HEAD;
 *  - **compile-and-apply** (replaces `DevStar.deployToDev`'s Galaxy pull, Decision 9):
 *    `compileAndInstallOntology` compiles the ontology `.d.ts` and installs it on the `.dev` Star;
 *  - the version is **content-addressed** (the Worker Loader `bundleId` cache guard);
 *  - the command surface is **admin-gated**.
 *
 * The container-push (`ensureUp`/`syncToDevContainer`) needs a live DEV_CONTAINER (`extends
 * Container` can't construct under pool-workers) — that behavior is now covered top-down by the
 * `ui-smoke` lane (`test/ui-smoke/smoke.test.ts`), not by an `it.skip` placeholder here.
 *
 * @see tasks/nebula-studio.md § DevStudio node
 * @see experiments/interim-dev-loop/RESULTS.md — the proven shell+git mechanism
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import { requireAdmin } from '../../../src/nebula-do';

const ONTOLOGY_PATH = 'src/ontology.d.ts';
const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;
const OID_RE = /^[0-9a-f]{40}$/;

// A DevStudio sandbox is addressed by a parseId-valid {u}.{g}.dev star-tier id.
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;

// Direct in-DO call — returns the method's result. For LOCAL methods (no cross-DO): the mesh
// early-ack path returns {$ack}, not the result, and these methods read only this.ctx/this.env
// (no callContext), so a direct in-DO call is faithful and gets the return value.
const inDO = (binding: any, instance: string, fn: (inst: any) => unknown) =>
  (runInDurableObject as any)(binding.getByName(instance), fn);

// Fire a method through the REAL early-ack receive path (claims injected in the envelope, the
// isolated-DO norm) so its cross-DO `lmz.call` effects PROPAGATE callContext. Returns the {$ack};
// the result travels via fire-back, so observe the durable cross-DO EFFECT with `inDO` + vi.waitFor.
// This is the @lumenize/mesh feasibility-test pattern (drive → {$ack} → poll the effect).
const fire = (
  binding: any, bindingName: string, instance: string, method: string,
  args: unknown[] = [], claims: any = { aud: instance, access: { admin: true } },
) =>
  binding.getByName(instance).__executeOperation({
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
    callContext: { callChain: [], state: {}, originAuth: { sub: 'admin', claims } } as any,
    metadata: { callee: { type: 'LumenizeDO', bindingName, instanceName: instance } },
  });

// NOTE: the source-of-truth git round-trip (writeSource distinct oids / readSource latest /
// getSourceTree) is exercised end-to-end by the ui-smoke lane (codegen → write → preview), so its
// per-oid unit assertions are retired here — they add no correctness confidence the higher-level
// flow doesn't already give.

describe('DevStudio compile-and-apply — installs a content-addressed ontology on the .dev Star', () => {
  // compileAndInstallOntology fires `setOntology` cross-DO to the .dev Star (fire-and-forget). Drive
  // it through the REAL receive path so the scope propagates, then observe the Star's ontology index
  // (the durable effect). The installed version IS the content hash, so its shape + count is the
  // assertion — the method's return value isn't needed.
  it('compiles the ontology .d.ts and installs a content-addressed version on the .dev Star', async () => {
    const dev = uniqueDevScope();
    await inDO(env.DEV_STUDIO, dev, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1)); // local commit
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'compileAndInstallOntology', [{}]);
    // Capable-of-failing: if compile+install never reached the Star, the index stays empty → times out.
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, dev, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      expect(index[0]).toMatch(OID_RE);
    });
  });

  it('the version is CONTENT-ADDRESSED — changing the ontology yields a new version', async () => {
    const dev = uniqueDevScope();
    await inDO(env.DEV_STUDIO, dev, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'compileAndInstallOntology', [{}]);
    let v1 = '';
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, dev, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      v1 = index[0];
    });
    // Edit → a DIFFERENT compiled version (git.hashBlob of the source). A constant label would
    // silently reuse the cached validator bundle → the index would stay at 1 (this reds).
    await inDO(env.DEV_STUDIO, dev, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'compileAndInstallOntology', [{}]);
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, dev, (s) => s.inspectOntologyIndex())) as string[];
      expect(index).toContain(v1);  // v1 still present (no wipe)
      expect(index.length).toBe(2); // + a distinct v2
    });
  });

  it('{ wipe: true } wipes the .dev Star BEFORE installing (Flow 1b wipe path)', async () => {
    const dev = uniqueDevScope();
    await inDO(env.DEV_STUDIO, dev, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'compileAndInstallOntology', [{}]);
    let vA = '';
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, dev, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      vA = index[0];
    });
    // Change + apply WITH wipe. resetDevData (deleteAll) must run BEFORE setOntology, so only the new
    // version remains. Capable-of-failing on the WIPE: a no-op / after-setOntology wipe → [vA, vB].
    await inDO(env.DEV_STUDIO, dev, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'compileAndInstallOntology', [{ wipe: true }]);
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, dev, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      expect(index).not.toContain(vA);
      expect(index[0]).toMatch(OID_RE);
    });
  });
});

describe('DevStudio command surface is admin-gated (requireAdmin)', () => {
  // The @mesh(requireAdmin) guard, tested PURE (the guard function directly). WIRING — which methods
  // carry requireAdmin (writeSource/compileAndInstallOntology/recordTurn/…) — is the static
  // frozen-surface test in devstudio-resource-surface.test.ts ("codegen/source methods stay
  // requireAdmin"); the framework invoking a wired guard is covered in @lumenize/mesh.
  it('rejects a non-admin claim, admits an admin claim', () => {
    const nonAdmin = { lmz: { callContext: { originAuth: { claims: { aud: 'x.y.dev' } } } } };
    expect(() => requireAdmin(nonAdmin as any)).toThrow('Admin access required');
    const admin = { lmz: { callContext: { originAuth: { claims: { access: { admin: true } } } } } };
    expect(() => requireAdmin(admin as any)).not.toThrow();
  });
});

describe('DevStudio turn recorder → Galaxy SQLite (persistence layer)', () => {
  // The half that needs `wrangler dev` is chat() firing recordTurn (needs the AI binding + container);
  // here we exercise the pool-workers-testable persistence: Galaxy.recordTurn / getTurns, driven
  // directly in-DO (both are local Galaxy methods — recordTurn writes SQL, getTurns reads it).
  const uniqueGalaxy = () => `${crypto.randomUUID()}.app`; // {u}.{g}
  const turn = (o: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), createdAt: Date.now(), instance: '', model: 'kimi',
    systemPrompt: 'sys', userMessage: 'make a todo app', currentSource: '',
    output: '```vue\n<template/>\n```', reasoning: '', toolCalls: [], applied: true,
    appliedPath: 'src/App.vue', ...o,
  });

  it('recordTurn persists a turn; getTurns returns the full record (round-trip)', async () => {
    const galaxy = uniqueGalaxy();
    const rec = turn({ instance: `${galaxy}.dev`, userMessage: 'build a kanban', reasoning: 'planning columns' });
    await inDO(env.GALAXY, galaxy, (g) => g.recordTurn(rec));
    const turns = (await inDO(env.GALAXY, galaxy, (g) => g.getTurns({}))) as any[];
    expect(turns.length).toBe(1);
    // The stored JSON payload IS the eval fixture — every field round-trips.
    expect(turns[0]).toMatchObject({
      id: rec.id, instance: `${galaxy}.dev`, userMessage: 'build a kanban',
      reasoning: 'planning columns', applied: true, appliedPath: 'src/App.vue', toolCalls: [],
    });
  });

  it('getTurns orders by createdAt and honors since + limit', async () => {
    const galaxy = uniqueGalaxy();
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await inDO(env.GALAXY, galaxy, (g) => g.recordTurn(turn({ id: `t${i}`, createdAt: base + i, instance: `${galaxy}.dev` })));
    }
    const ids = async (opts: any) => ((await inDO(env.GALAXY, galaxy, (g) => g.getTurns(opts))) as any[]).map((t) => t.id);
    expect(await ids({})).toEqual(['t0', 't1', 't2']); // oldest → newest
    expect(await ids({ since: base + 1 })).toEqual(['t1', 't2']);
    expect(await ids({ limit: 1 })).toEqual(['t0']);
  });
});

// The assembled-container + live-`chat()` behaviors (ensureUp/syncToDevContainer push,
// applyOntologyChange ordering, a chat turn self-correcting + recording a TurnRecord, the
// non-blank SFC mount) are now covered top-down by the `ui-smoke` lane
// (`test/ui-smoke/smoke.test.ts`) — and the container-free halves (loop driver, gates,
// recorder round-trip, self-correction, reload channel) are covered deterministically in
// codegen-loop.test.ts / codegen-gate.test.ts / baseline/reload-version-contract.test.ts.
// So no `it.skip` placeholders remain here.
