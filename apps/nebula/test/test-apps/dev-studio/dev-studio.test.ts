/**
 * Galaxy source-of-truth + compile-and-apply (the `dev-studio` project — its name
 * predates the collapse of DevStudio into Galaxy).
 *
 * Driven via `__executeOperation` envelopes (no Gateway/JWT), so the real receive seam
 * runs (onBeforeCall passage guard + requireDominionHere). Proves:
 *  - **append + lazy-pull**: `appendWorkspaceOntology` compiles the Workspace's ontology
 *    `.d.ts` into the Galaxy's registry (no downward push exists), and a Star data op
 *    naming that version — under a plain MEMBER's claims — pulls + installs it, honoring
 *    the row's `wipeOnInstall`;
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

describe('Galaxy ontology registry + Star LAZY-PULL (the eager push is deleted)', () => {
  // The dev apply is APPEND-ONLY on the Galaxy's registry; a Star acquires a version by
  // pulling it on a data op whose expected version it doesn't hold — under the asking
  // member's OWN claims (upward passage), which is the auth story the eager downward
  // push never had.
  it('appendWorkspaceOntology appends a content-addressed version to the REGISTRY — no Star involvement', async () => {
    const galaxy = uniqueGalaxyScope();
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{}]);
    await vi.waitFor(async () => {
      const versions = (await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[];
      expect(versions.length).toBe(1);
      expect(versions[0]).toMatch(OID_RE);
    }, { timeout: 15000 });
    // Capable-of-failing on the DELETED push: the .dev Star holds nothing until it pulls.
    expect(await inDO(env.STAR, `${galaxy}.dev`, (s) => s.inspectOntologyIndex())).toEqual([]);
  });

  it('the version is CONTENT-ADDRESSED — changing the ontology yields a new version; unchanged is a no-op', async () => {
    const galaxy = uniqueGalaxyScope();
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{}]);
    await vi.waitFor(async () => {
      expect(((await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[]).length).toBe(1);
    }, { timeout: 15000 });
    // Unchanged source re-applied → already appended → still 1.
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{}]);
    await new Promise((r) => setTimeout(r, 250));
    expect(((await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[]).length).toBe(1);
    // Edit → a DIFFERENT content hash → a second version appended.
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{}]);
    await vi.waitFor(async () => {
      expect(((await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[]).length).toBe(2);
    }, { timeout: 15000 });
  });

  it('LAZY-PULL: a data op with the appended version, under NON-ADMIN claims, installs it on the Star', async () => {
    const galaxy = uniqueGalaxyScope();
    const star = `${galaxy}.dev`;
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{}]);
    let version = '';
    await vi.waitFor(async () => {
      const versions = (await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[];
      expect(versions.length).toBe(1);
      version = versions[0];
    }, { timeout: 15000 });
    // A data op naming the new version, from a plain MEMBER at the star — no `scopeAdmin`
    // anywhere in the claims. The pull is an upward call under these same claims, so it
    // works for every member (the auth story the deleted eager push never had). The op
    // itself answers `installing`-stale (a cross-node pull cannot be awaited, ADR-003);
    // the traveling handler installs, which is the durable effect asserted here.
    await fire(env.STAR, 'STAR', star, 'read', [version, crypto.randomUUID()],
      { aud: star, access: { authScope: star } });
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, star, (s) => s.inspectOntologyIndex())) as string[];
      expect(index).toContain(version);
    }, { timeout: 15000 });
  });

  it('wipeOnInstall: a version appended with { wipe: true } wipes the OLDER install first; a plain append does not', async () => {
    const galaxy = uniqueGalaxyScope();
    const star = `${galaxy}.dev`;
    const member = { aud: star, access: { authScope: star } };
    // V1 → pull-install on the star.
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{}]);
    let v1 = '';
    await vi.waitFor(async () => {
      const versions = (await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[];
      expect(versions.length).toBe(1);
      v1 = versions[0];
    }, { timeout: 15000 });
    await fire(env.STAR, 'STAR', star, 'read', [v1, crypto.randomUUID()], member);
    await vi.waitFor(async () => {
      expect((await inDO(env.STAR, star, (s) => s.inspectOntologyIndex())) as string[]).toContain(v1);
    }, { timeout: 15000 });
    // V2 appended WITH the wipe decision → the pull wipes before installing, so ONLY v2
    // remains. Capable-of-failing on the WIPE: a no-wipe install yields [v1, v2].
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await fire(env.GALAXY, 'GALAXY', galaxy, 'appendWorkspaceOntology', [{ wipe: true }]);
    let v2 = '';
    await vi.waitFor(async () => {
      const versions = (await inDO(env.GALAXY, galaxy, (s) => s.listOntologyVersions())) as string[];
      expect(versions.length).toBe(2);
      v2 = versions[1];
    }, { timeout: 15000 });
    await fire(env.STAR, 'STAR', star, 'read', [v2, crypto.randomUUID()], member);
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, star, (s) => s.inspectOntologyIndex())) as string[];
      expect(index).toContain(v2);
      expect(index).not.toContain(v1); // the wipe cleared the older install
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

describe('Galaxy turn runner — single-flight latch + generation deadline', () => {
  // The criterion the deadline exists for: a NEVER-RESOLVING model call must not wedge the
  // core loop with every suite green — the latch would refuse every later message forever.
  // Driven through the REAL early-ack envelope path; the probe captures commits + timings
  // in storage, polled here.
  it('a hung generation is deadline-released, the latch refuses DURING it, and a post-deadline fresh trigger generates', async () => {
    const scope = uniqueGalaxyScope();
    await fire(env.GALAXY_DEADLINE, 'GALAXY_DEADLINE', scope, 'chatDeadlineScenario');
    const outcome = await vi.waitFor(async () => {
      const o = await inDO(env.GALAXY_DEADLINE, scope,
        (inst: any) => inst.ctx.storage.kv.get('probe:scenario'));
      expect(o).toBeTruthy();
      return o as { busyMs: number; hungMs: number; committed: { messageId: string; content: string; replyTo: string }[] };
    }, { timeout: 15000 });

    // (2) The single-flight refusal returned AT ONCE (no model round, no deadline wait).
    expect(outcome.busyMs).toBeLessThan(300);
    // (3) The hung turn released at the deadline (~800ms), not at the model (never).
    expect(outcome.hungMs).toBeGreaterThanOrEqual(700);
    expect(outcome.hungMs).toBeLessThan(5000);
    // (4) THE CRITERION: exactly ONE durable commit — the fresh post-deadline turn's.
    // The hung turn (never completed) and the busy turn (refused) committed nothing.
    expect(outcome.committed).toHaveLength(1);
    expect(outcome.committed[0]).toMatchObject({ content: 'fresh turn ran', replyTo: 'm-fresh' });
  });
});
