/**
 * Galaxy source-of-truth + compile-and-apply (the `dev-studio` project — its name
 * predates the collapse of DevStudio into Galaxy).
 *
 * Driven via `__executeOperation` envelopes (no Gateway/JWT) carrying an admin claim
 * at the `{u}.{g}` scope, so the real receive seam runs (onBeforeCall passage guard
 * + requireDominionHere). Proves:
 *  - **compile-and-apply**: `compileAndInstallOntology` compiles the ontology `.d.ts`
 *    and installs it on the DERIVED `{u}.{g}.dev` Star (post-collapse the brain sits
 *    one level above the workspace Star);
 *  - the version is **content-addressed** (the Worker Loader `bundleId` cache guard);
 *  - the command surface is **admin-gated** (the guard's operands, tested pure).
 *
 * The source-of-truth git round-trip (writeSource distinct oids / readSource latest) is
 * exercised as a fixture step here and end-to-end by the codegen-loop integration tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import { requireDominionHere } from '../../../src/nebula-do';

const ONTOLOGY_PATH = 'src/ontology.d.ts';
const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;
const OID_RE = /^[0-9a-f]{40}$/;

// The Galaxy is addressed by a parseId-valid {u}.{g} galaxy-tier id; its workspace
// Star is the derived {u}.{g}.dev.
const uniqueGalaxyScope = () => `${crypto.randomUUID()}.app`;

// Direct in-DO call — returns the method's result. For LOCAL methods (no cross-DO): the mesh
// early-ack path returns {$ack}, not the result, and these methods read only this.ctx/this.env
// (no callContext), so a direct in-DO call is faithful and gets the return value.
const inDO = (binding: any, instance: string, fn: (inst: any) => unknown) =>
  (runInDurableObject as any)(binding.getByName(instance), fn);

// Fire a method through the REAL early-ack receive path (claims injected in the envelope, the
// isolated-DO norm) so its cross-DO `lmz.call` effects PROPAGATE callContext. Returns the {$ack};
// the result travels via fire-back, so observe the durable cross-DO EFFECT with `inDO` + vi.waitFor.
// This is the @lumenize/mesh feasibility-test pattern (drive → {$ack} → poll the effect).
// ⚠️ Every such poll passes an explicit `{ timeout: 15000 }`. vitest's 1s default loses to
// full-suite parallel load (85 files sharing the box), and the symptom is a MOVING failure — a
// different one of these times out each run, which reads as an unrelated flake. Raising the
// ceiling weakens nothing: an effect that never lands still reds, just later.
// ⚠️ `authScope` is REQUIRED in the default claims, not decoration: `requireDominionHere` confines
// the admin bit to the callee node (`hasDominionOver`), so a pattern-less admin claim is denied —
// and because these are 3-arg fire-and-forget calls, that denial is SILENT (it surfaces as a missing
// downstream effect, e.g. `expected +0 to be 1`, not as an error). The value mirrors the real caller
// that reaches a Galaxy: a universe admin, whose pattern is `{universe}.*`.
const fire = (
  binding: any, bindingName: string, instance: string, method: string,
  args: unknown[] = [],
  claims: any = {
    aud: instance,
    access: { scopeAdmin: true, authScope: `${instance.split('.')[0]}` },
  },
) =>
  binding.getByName(instance).__executeOperation({
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
    callContext: { callChain: [], state: {}, originAuth: { sub: 'admin', claims } } as any,
    metadata: { callee: { type: 'LumenizeDO', bindingName, instanceName: instance } },
  });

describe('Galaxy compile-and-apply — installs a content-addressed ontology on the derived .dev Star', () => {
  // compileAndInstallOntology fires `setOntology` cross-DO to the {u}.{g}.dev Star (fire-and-
  // forget). Drive it through the REAL receive path so the scope propagates, then observe the
  // Star's ontology index (the durable effect). The installed version IS the content hash, so its
  // shape + count is the assertion — the method's return value isn't needed.
  it('compiles the ontology .d.ts and installs a content-addressed version on the .dev Star', async () => {
    const galaxy = uniqueGalaxyScope();
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1)); // local commit
    await fire(env.GALAXY, 'GALAXY', galaxy, 'compileAndInstallOntology', [{}]);
    // Capable-of-failing: if compile+install never reached the Star, the index stays empty → times out.
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, `${galaxy}.dev`, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      expect(index[0]).toMatch(OID_RE);
    }, { timeout: 15000 });
  });

  it('the version is CONTENT-ADDRESSED — changing the ontology yields a new version', async () => {
    const galaxy = uniqueGalaxyScope();
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'compileAndInstallOntology', [{}]);
    let v1 = '';
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, `${galaxy}.dev`, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      v1 = index[0];
    }, { timeout: 15000 });
    // Edit → a DIFFERENT compiled version (git.hashBlob of the source). A constant label would
    // silently reuse the cached validator bundle → the index would stay at 1 (this reds).
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'compileAndInstallOntology', [{}]);
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, `${galaxy}.dev`, (s) => s.inspectOntologyIndex())) as string[];
      expect(index).toContain(v1);  // v1 still present (no wipe)
      expect(index.length).toBe(2); // + a distinct v2
    }, { timeout: 15000 });
  });

  it('{ wipe: true } wipes the .dev Star BEFORE installing (Flow 1b wipe path)', async () => {
    const galaxy = uniqueGalaxyScope();
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'compileAndInstallOntology', [{}]);
    let vA = '';
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, `${galaxy}.dev`, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      vA = index[0];
    }, { timeout: 15000 });
    // Change + apply WITH wipe. resetDevData (deleteAll) must run BEFORE setOntology, so only the new
    // version remains. Capable-of-failing on the WIPE: a no-op / after-setOntology wipe → [vA, vB].
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'compileAndInstallOntology', [{ wipe: true }]);
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, `${galaxy}.dev`, (s) => s.inspectOntologyIndex())) as string[];
      expect(index.length).toBe(1);
      expect(index).not.toContain(vA);
      expect(index[0]).toMatch(OID_RE);
    }, { timeout: 15000 });
  });
});

describe('Galaxy command surface is admin-gated (requireDominionHere)', () => {
  // The @mesh(requireDominionHere) guard, tested PURE (the guard function directly). WIRING — which
  // methods carry requireDominionHere (writeSource/compileAndInstallOntology/chat/…) — is the static
  // frozen-surface test in devstudio-resource-surface.test.ts ("codegen/source methods stay
  // requireDominionHere"); the framework invoking a wired guard is covered in @lumenize/mesh.
  // The guard has THREE independent operands; each gets its own probe so a mutation to one reds a
  // distinct test (testing.md § compound conditions). Node under test: the galaxy `u.y`.
  const NODE = 'u.y';
  // ⚠️ Two builders, NOT one with a defaulted param: passing `undefined` explicitly to a parameter
  // that has a default triggers the default, so `guard(claims, undefined)` would silently test the
  // named node instead of the absent-name path — a test that cannot fail.
  const guard = (claims: unknown) =>
    () => requireDominionHere({ lmz: { callContext: { originAuth: { claims } }, instanceName: NODE } } as any);
  const guardNoName = (claims: unknown) =>
    () => requireDominionHere({ lmz: { callContext: { originAuth: { claims } } } } as any);

  it('operand 1 — rejects a non-admin claim', () => {
    expect(guard({ aud: NODE })).toThrow('Admin access required');
  });

  it('operand 2 — rejects an admin whose pattern does NOT cover this node, naming the scope', () => {
    // A galaxy-scoped admin (exact pattern) reaching a SIBLING node: admin bit set, pattern misses.
    // This is the escalation the confinement closes; pre-fix it returned silently.
    const foreign = { aud: 'u.other', access: { scopeAdmin: true, authScope: 'u.other' } };
    expect(guard(foreign)).toThrow(`Admin access required for ${NODE}`);
    expect(guard(foreign)).toThrow('your admin scope is u.other'); // distinct from operand 1
  });

  it('operand 3 — fails CLOSED when the callee instance name is absent', () => {
    // Permanently undefined on a LumenizeWorker; must never coerce (`?? ''` would deny every
    // scoped admin, `!` would open the hole).
    const admin = { access: { scopeAdmin: true, authScope: 'u' } };
    expect(guardNoName(admin)).toThrow('missing callee instance name');
  });

  it('admits an admin whose pattern covers this node (exact and wildcard)', () => {
    expect(guard({ access: { scopeAdmin: true, authScope: 'u' } })).not.toThrow();
    expect(guard({ access: { scopeAdmin: true, authScope: 'u.y' } })).not.toThrow();
    expect(guard({ access: { scopeAdmin: true, authScope: 'nebula-platform' } })).not.toThrow();
  });

  it('a pattern-less admin claim is DENIED, not a TypeError (the predicate guard)', () => {
    // a hand-rolled compare on an absent claim would throw; `hasDominionOver` returns false so
    // the caller gets the clean scope-naming denial. Mutation: drop the truthiness guard in
    // `hasDominionOver` → this reds with a TypeError instead.
    expect(guard({ access: { scopeAdmin: true } })).toThrow('Admin access required for');
  });
});

// (The `Turns` recorder describe that lived here is DELETED with the apparatus — an agent
// `Message` IS a codegen turn; the corpus folds into its `codegen` value object in Phase 2
// of tasks/nebula-galaxy-collapse-and-chat.md.)
