/**
 * Galaxy source-of-truth + compile-and-land (the `dev-studio` project — its name
 * predates the collapse of DevStudio into Galaxy).
 *
 * Driven via `__executeOperation` envelopes (no client/JWT), so the real receive seam
 * runs (onBeforeCall passage guard + requireDominionHere). Proves:
 *  - **landing + lazy-pull**: a build that lands makes its compiled row the `.dev` Star's,
 *    a build that does not land moves nothing, and a `.dev` data op — under a plain MEMBER's
 *    claims — pulls and installs it, while a tenant Star asks and installs nothing;
 *  - the version is **content-addressed** (the Worker Loader `bundleId` cache guard);
 *  - the command surface is **admin-gated** (the guard's operands, tested pure).
 *
 * The source-of-truth git round-trip (writeSource distinct oids / readSource latest) is
 * exercised as a fixture step here and end-to-end by the codegen-loop integration tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import { requireDominionHere } from '@lumenize/mesh';
import { ROOT_NODE_ID } from '@lumenize/resources/client';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import git from 'isomorphic-git';
import { ROW_PATH, SKIPPED_FOR_ONTOLOGY } from '../../../src/build-report';

const ONTOLOGY_PATH = 'src/ontology.d.ts';
const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;
const TODO_V3 = `interface Todo { title: string; done: boolean; priority: string; due?: string; }`;
const BROKEN = `interface Todo { title: string`;
const DEV_ROW_KEY = 'galaxy:devOntologyRow';
type SinkEntry = { namespace: string; message: string; data?: Record<string, any> };

// The Galaxy is addressed by a parseId-valid {u}.{g} galaxy-tier id; its workspace
// Star is the derived {u}.{g}.dev.
const uniqueGalaxyScope = () => `u${crypto.randomUUID().slice(0, 8)}.app`;

/** The version a source hashes to — the same `git.hashBlob` the Galaxy computes. */
const versionOf = async (types: string) => (await git.hashBlob({ object: types })).oid;

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
// and because `fire`'s envelopes carry no `response` and its callers do not read the ack, that
// denial is SILENT (it surfaces as a missing downstream effect, e.g. `expected +0 to be 1`, not as
// an error). The value mirrors the real caller
// that reaches a Galaxy: a universe admin, whose pattern is `{universe}.*`.
// `method` is a name, or a PATH through a gate — `['resources', 'read']` reaches the plane's `read`
// through the host's `resources` door, one `get` per segment, as a client's chain does.
// `callChain` names the call's origin — a client's, for an op the door derives a client id from.
const fire = (
  binding: any, bindingName: string, instance: string, method: string | string[],
  args: unknown[] = [],
  claims: any = {
    aud: instance,
    profileId: 'p-admin',
    access: { scopeAdmin: true, authScope: `${instance.split('.')[0]}` },
  },
  callChain: unknown[] = [],
) =>
  binding.getByName(instance).__executeOperation({
    version: 1,
    chain: preprocess([...[method].flat().map((key) => ({ type: 'get', key })), { type: 'apply', args }]),
    callContext: { callChain, originAuth: { sub: 'admin', claims } } as any,
    metadata: { callee: { type: 'LumenizeDO', bindingName, instanceName: instance } },
  });

/** The `.dev` Star's current row's version, read straight from the Galaxy's storage. */
const devRowVersion = (galaxy: string) => inDO(env.GALAXY, galaxy, (s) =>
  s.ctx.storage.kv.get(DEV_ROW_KEY)?.version ?? null) as Promise<string | null>;

/** The `index.html` `.dev` serves: the copy the last landing made outside `/workspace`. */
const servedIndex = (galaxy: string) => inDO(env.GALAXY, galaxy, (s) =>
  s.workspaceFs().readFile('/dist-dev/index.html', 'utf8').catch(() => null)) as Promise<string | null>;

/** One real `buildNow`, in-DO, with the faked job doing `faults` until they are set again. */
const build = (galaxy: string, faults?: object) => inDO(env.GALAXY, galaxy, (s) => {
  if (faults) s.setBuildFaultsForTest(faults);
  return s.buildNow({});
}) as Promise<any>;

describe('the .dev Star runs the last landed build\'s row; nothing else moves it', () => {
  // A build lands when its bundle succeeded and arrived, and, when the file changed, its compile
  // succeeded too (`decideLanding`). The landed row is the Galaxy's own copy, read back from the
  // mount and checked against the version the host hashed. These cases drive the real
  // `buildNow` over the faked job (`fake-build.ts`), so the landing runs unchanged.
  it('a landed build makes its row current; editing or reverting the file without a build moves nothing', async () => {
    const galaxy = uniqueGalaxyScope();
    const v1 = await versionOf(TODO_V1);
    const v2 = await versionOf(TODO_V2);
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    expect(await devRowVersion(galaxy)).toBeNull(); // a write is not a build
    const first = await build(galaxy);
    expect(first.ontology).toMatchObject({ ran: true, ok: true });
    expect(await devRowVersion(galaxy)).toBe(v1);
    // A draft moves nothing until it is built; then the revert is a build like any other.
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    expect(await devRowVersion(galaxy)).toBe(v1);
    await build(galaxy);
    expect(await devRowVersion(galaxy)).toBe(v2);
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    expect(await devRowVersion(galaxy)).toBe(v2);
    await build(galaxy);
    expect(await devRowVersion(galaxy)).toBe(v1);
    // Content-addressed: a build of an unchanged file compiles nothing.
    const unchanged = await build(galaxy);
    expect(unchanged.ontology).toMatchObject({ ran: false });
    expect(await devRowVersion(galaxy)).toBe(v1);
  });

  // Mutations: drop the hash check in `#land` (the mislabeled and stale cases red), skip the
  // store (every case reds), store the file by spreading it (the dressed case reds), or copy the
  // build to `/dist-dev/` before the row's check (the mislabeled and stale cases red on the served
  // page, which each of them changes). `decideLanding`'s own conjuncts are mutated in its table
  // (`test/ontology-landing.test.ts`), since arrival here also requires the bundle.
  it('a build that does not land leaves the row where it was, and the next good build lands', async () => {
    const galaxy = uniqueGalaxyScope();
    const v1 = await versionOf(TODO_V1);
    const v2 = await versionOf(TODO_V2);
    const v3 = await versionOf(TODO_V3);
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await build(galaxy);
    expect(await devRowVersion(galaxy)).toBe(v1);

    // A failed bundle: the compile ran, the page did not change, so the types do not either.
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    const failed = await build(galaxy, { failBundle: true });
    expect(failed.ontology).toMatchObject({ ran: true, ok: true });
    expect(await devRowVersion(galaxy)).toBe(v1);
    // Recovery: the same types, rebuilt, land.
    await build(galaxy, {});
    expect(await devRowVersion(galaxy)).toBe(v2);

    // A failed compile skips the bundle, and says why in words the model can act on.
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, BROKEN));
    const broken = await build(galaxy);
    expect(broken.ontology).toMatchObject({ ran: true, ok: false });
    expect(broken.bundle).toEqual({ ran: false, why: SKIPPED_FOR_ONTOLOGY });
    expect(await devRowVersion(galaxy)).toBe(v2);

    // A file changed between the host's hash and the compile: the types do not hash to the version.
    // The build also changes the page, so a copy made before the check would show on `.dev`.
    const servedBefore = await servedIndex(galaxy);
    expect(servedBefore).toBeTruthy();
    const ROW_REFUSED = { refreshed: false, why: 'the compiled types do not match the version the build was asked for — build again' };
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V3));
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource('src/App.vue', '<template>mislabeled</template>'));
    const mislabeled = await build(galaxy, { compileTypes: TODO_V1 });
    expect(mislabeled.bundle).toMatchObject({ ran: true, ok: true });
    expect(mislabeled.preview).toEqual(ROW_REFUSED);
    expect(await devRowVersion(galaxy)).toBe(v2);
    expect(await servedIndex(galaxy)).toBe(servedBefore);

    // A stale row file: the compile reported success, but ROW_PATH holds an earlier build's row.
    await inDO(env.GALAXY, galaxy, (s) =>
      s.workspaceFs().writeFile(`/workspace/${ROW_PATH}`, JSON.stringify(s.ctx.storage.kv.get(DEV_ROW_KEY))));
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource('src/App.vue', '<template>stale</template>'));
    const stale = await build(galaxy, { loseRow: true });
    expect(stale.preview).toEqual(ROW_REFUSED);
    expect(await devRowVersion(galaxy)).toBe(v2);
    expect(await servedIndex(galaxy)).toBe(servedBefore);

    // A row file the build dressed: its types hash to the version, but it carries another label
    // and a key of its own. The stored row is the hash and the four fields, nothing more.
    const dressed = await build(galaxy, { dressRow: { version: 'planted', planted: true } });
    expect(dressed.preview.refreshed).toBe(true);
    expect(await servedIndex(galaxy)).not.toBe(servedBefore); // the page lands with its row
    const stored = await inDO(env.GALAXY, galaxy, (s) => s.ctx.storage.kv.get(DEV_ROW_KEY)) as Record<string, unknown>;
    expect(stored.version).toBe(v3);
    expect(Object.keys(stored).sort()).toEqual(['relationships', 'types', 'validatorBundle', 'version']);
  });

  // Mutation: compare the file with the row before the build ahead has landed (drop the queue
  // around `#buildAndLand`); the second build is then passed no version and the newer row stays.
  it('a file reverted between two overlapping builds leaves the reverted row current', async () => {
    const galaxy = uniqueGalaxyScope();
    const v1 = await versionOf(TODO_V1);
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await build(galaxy);
    expect(await devRowVersion(galaxy)).toBe(v1);
    await inDO(env.GALAXY, galaxy, async (s) => {
      let compiled!: () => void;
      const firstCompiled = new Promise<void>((r) => { compiled = r; });
      s.setBuildFaultsForTest({ onCompiled: () => compiled(), holdMs: 300 });
      await s.writeSource(ONTOLOGY_PATH, TODO_V2);
      const first = s.buildNow({});
      await firstCompiled; // the first build compiled v2 and has yet to land it
      s.setBuildFaultsForTest({});
      await s.writeSource(ONTOLOGY_PATH, TODO_V1); // the revert, while the first build runs
      await Promise.all([first, s.buildNow({})]);
    });
    expect(await devRowVersion(galaxy)).toBe(v1);
  });

  it('LAZY-PULL: a data op on the .dev Star, under NON-ADMIN claims, installs the landed row', async () => {
    const galaxy = uniqueGalaxyScope();
    const star = `${galaxy}.dev`;
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await build(galaxy);
    const version = (await devRowVersion(galaxy))!;
    // A data op naming the landed version, from a plain MEMBER at the star — no `scopeAdmin`
    // anywhere in the claims. The pull is an upward call under these same claims, so it
    // works for every member. The op itself answers `checking`-stale (a cross-node pull
    // cannot be awaited, ADR-003); the traveling handler installs, the durable effect here.
    await fire(env.STAR, 'STAR', star, ['resources', 'read'], [version, crypto.randomUUID()],
      { aud: star, access: { authScope: star } });
    await vi.waitFor(async () => {
      const index = (await inDO(env.STAR, star, (s) => s.inspectOntologyIndex())) as string[];
      expect(index).toContain(version);
    }, { timeout: 15000 });
  });

  // The Galaxy answers by which Star asks (`isDevStarCall`), so a build's row never reaches a
  // tenant before something is published. Mutation: answer every caller with the `.dev` row.
  it('a tenant Star asks its Galaxy and installs nothing', async () => {
    const galaxy = uniqueGalaxyScope();
    const tenant = `${galaxy}.tenant1`;
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await build(galaxy);
    const version = (await devRowVersion(galaxy))!;
    const entries: SinkEntry[] = [];
    setDebugSink((e) => entries.push(e as unknown as SinkEntry));
    try {
      await fire(env.STAR, 'STAR', tenant, ['resources', 'read'], [version, crypto.randomUUID()],
        { aud: tenant, access: { authScope: tenant } });
      await vi.waitFor(() => {
        expect(entries.some((e) => e.namespace === 'nebula.Resources.ontology'
          && e.message === 'ontology pull returned no row' && e.data?.instanceName === tenant)).toBe(true);
      }, { timeout: 15000 });
      const asked = entries.filter((e) => e.namespace === 'nebula.Galaxy.ontology' && e.message === 'current asked');
      expect(asked.map((e) => e.data)).toEqual([expect.objectContaining({ caller: tenant, dev: false })]);
    } finally {
      clearDebugSink();
    }
    expect(await inDO(env.STAR, tenant, (s) => s.inspectOntologyIndex())).toEqual([]);
  });

  it('installing a newer version keeps the older data, and the new validator judges new writes', async () => {
    const galaxy = uniqueGalaxyScope();
    const star = `${galaxy}.dev`;
    const member = { aud: star, access: { authScope: star } };
    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V1));
    await build(galaxy);
    const v1 = (await devRowVersion(galaxy))!;
    await fire(env.STAR, 'STAR', star, ['resources', 'read'], [v1, crypto.randomUUID()], member);
    await vi.waitFor(async () => {
      expect((await inDO(env.STAR, star, (s) => s.inspectOntologyIndex())) as string[]).toContain(v1);
    }, { timeout: 15000 });
    // A v1 write warms v1's validator, so a facet that outlived the install would judge the v2
    // writes below.
    const client = [{ type: 'LumenizeClient', bindingName: 'STAR', instanceName: `${star}/admin.tab` }];
    const admin = { aud: star, profileId: 'p-admin', access: { scopeAdmin: true, authScope: galaxy.split('.')[0] } };
    const rows = (rid: string) => inDO(env.STAR, star, (s) =>
      s.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM Snapshots WHERE resourceId = ?', rid).toArray()[0].n) as Promise<number>;
    const todo = (value: object) => ({ op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value });
    const warm = crypto.randomUUID();
    await fire(env.STAR, 'STAR', star, ['resources', 'transaction'],
      [v1, crypto.randomUUID(), { [warm]: todo({ title: 'v1', done: false }) }], admin, client);
    await vi.waitFor(async () => expect(await rows(warm)).toBe(1), { timeout: 15000 });

    await inDO(env.GALAXY, galaxy, (s) => s.writeSource(ONTOLOGY_PATH, TODO_V2));
    await build(galaxy);
    const v2 = (await devRowVersion(galaxy))!;
    await fire(env.STAR, 'STAR', star, ['resources', 'read'], [v2, crypto.randomUUID()], member);
    await vi.waitFor(async () => {
      expect((await inDO(env.STAR, star, (s) => s.inspectOntologyIndex())) as string[]).toContain(v2);
    }, { timeout: 15000 });
    // Installing never wipes: the v1 row is still there for a person to reset.
    expect(await rows(warm)).toBe(1);

    // What the replacement plane SERVES, not only what its index says: v2's validator judges a
    // v2 write — the create lacking v2's required `priority` is refused and the one carrying it
    // lands — and an op pinned to v1 is answered stale.
    const lacking = crypto.randomUUID();
    const carrying = crypto.randomUUID();
    await fire(env.STAR, 'STAR', star, ['resources', 'transaction'],
      [v2, crypto.randomUUID(), { [lacking]: todo({ title: 'a', done: false }) }], admin, client);
    await fire(env.STAR, 'STAR', star, ['resources', 'transaction'],
      [v2, crypto.randomUUID(), { [carrying]: todo({ title: 'b', done: false, priority: 'high' }) }], admin, client);
    await vi.waitFor(async () => expect(await rows(carrying)).toBe(1), { timeout: 15000 });
    expect(await rows(lacking)).toBe(0);
    const pinnedToV1 = await inDO(env.STAR, star, (s) => {
      try { s.resources.read(v1, crypto.randomUUID()); return null; } catch (e) { return (e as Error).name; }
    });
    expect(pinnedToV1).toBe('OntologyStaleError');
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

  it('operand 2 — rejects an admin whose host does NOT cover this node, naming the host and membership', () => {
    // A galaxy-scoped admin reaching a SIBLING node: admin bit set, the host's scope misses.
    // This is the escalation the confinement closes; pre-fix it returned silently.
    const foreign = { aud: 'u.other', access: { scopeAdmin: true, authScope: 'u.other' } };
    expect(guard(foreign)).toThrow(`Admin access required for ${NODE}`);
    expect(guard(foreign)).toThrow("the calling host's scope is u.other"); // distinct from operand 1
  });

  it("operand 2, the host rule — a membership covering this node is not dominion from a host that misses it", () => {
    // A universe admin whose token was minted on a sibling's host: the membership covers NODE, the
    // host does not, and the message names both, so the refusal does not read as a missing role.
    const fromSibling = { aud: 'u.other', access: { scopeAdmin: true, authScope: 'u' } };
    expect(guard(fromSibling)).toThrow(
      `Admin access required for ${NODE} — the calling host's scope is u.other, and the token rests on the membership at u`);
    expect(guard({ aud: NODE, access: { scopeAdmin: true, authScope: 'u' } })).not.toThrow();
  });

  it('operand 3 — fails CLOSED when the callee instance name is absent', () => {
    // Permanently undefined on a MeshWorker; must never coerce (`?? ''` would deny every
    // scoped admin, `!` would open the hole).
    const admin = { access: { scopeAdmin: true, authScope: 'u' } };
    expect(guardNoName(admin)).toThrow('missing callee instance name');
  });

  it('admits an admin whose pattern covers this node (exact and wildcard)', () => {
    expect(guard({ aud: 'u', access: { scopeAdmin: true, authScope: 'u' } })).not.toThrow();
    expect(guard({ aud: 'u.y', access: { scopeAdmin: true, authScope: 'u.y' } })).not.toThrow();
    // A superuser on the universe's host — the membership is the platform root, the host is `u`.
    expect(guard({ aud: 'u', access: { scopeAdmin: true, authScope: '_platform' } })).not.toThrow();
  });

  it('a pattern-less admin claim is DENIED, not a TypeError (the predicate guard)', () => {
    // a hand-rolled compare on an absent claim would throw; `hasDominionOver` returns false so
    // the caller gets the clean scope-naming denial. Mutation: drop the truthiness guard in
    // `hasDominionOver` → this reds with a TypeError instead.
    expect(guard({ access: { scopeAdmin: true } })).toThrow('Admin access required for');
  });
});

// (The `Turns` recorder describe that lived here is DELETED with the apparatus — an agent
// `Message` IS a codegen turn; the corpus folds into its `codegen` value object, per
// tasks/archive/nebula-galaxy-collapse-and-chat.md.)

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
