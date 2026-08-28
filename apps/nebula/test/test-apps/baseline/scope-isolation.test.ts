/**
 * Structural DO scope isolation (Fix 1) — tier DOs Star / Galaxy / Universe.
 *
 * NebulaDO.onBeforeCall accepts a mesh call iff its `aud` is covered by the
 * scope encoded in the DO's *instance name* (`isAtOrAbove(name, aud)`),
 * replacing the old trust-on-first-use `aud`-lock.
 *
 * Every test here is capable-of-failing: it flips RED if the gate reverts to
 * TOFU (first-caller-wins) or drops the structural check.
 *
 * @see tasks/nebula-do-scope-isolation.md (the test matrix)
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugSink } from '@lumenize/debug';
import { Galaxy, Universe, requireDominionHere, requirePassage } from '@lumenize/nebula';
import { isAtOrAbove } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import {
  adminClientAt, universeAdminClient,
  createInvitedClient,
  bootstrapAdmin,
  createSubject,
  refreshToken,
  foundAndLogin,
  foundStarAndLogin,
  uniqueGalaxyScope,
  uniqueStar,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('structural scope isolation (Fix 1)', () => {
  // ── T1 — Shared-Galaxy multi-star (RED→GREEN) ──────────────────────────
  // Two sibling stars under ONE galaxy both reach the shared Galaxy DO with
  // their distinct star-level `aud`. TOFU locked the Galaxy to whichever aud
  // arrived first and rejected the sibling; the galaxy-scope pattern
  // (`<galaxy>.*`) covers both descendants.
  it('T1: shared Galaxy serves two sibling stars (not first-caller-wins)', async () => {
    const browser = new Browser();
    const { galaxy, starA, starB } = uniqueGalaxyScope();

    // One admin at the galaxy; two clients at sibling star activeScopes.
    // Both clients share the single Galaxy DO `galaxy` — the collision under test.
    const { client: clientA } = await universeAdminClient(
      NebulaClientTest, browser, galaxy, starA, 'admin@example.com',
    );
    const { client: clientB } = await universeAdminClient(
      NebulaClientTest, browser, galaxy, starB, 'admin@example.com',
    );

    // Sibling A reads the (empty) shared ontology — accepted under both models.
    clientA.callGalaxyGetLatestOntologyVersion(galaxy);
    await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
    expect(clientA.lastError).toBeUndefined();
    expect(clientA.lastResult).toBeNull();

    // Sibling B reads the SAME Galaxy with a different star-level aud.
    // TOFU: 'Active-scope mismatch' (RED). Structural: accepted (covered by `<galaxy>.*`).
    clientB.callGalaxyGetLatestOntologyVersion(galaxy);
    await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
    expect(clientB.lastError).toBeUndefined();
    expect(clientB.lastResult).toBeNull();

    clientA[Symbol.dispose]();
    clientB[Symbol.dispose]();
  });

  // Canary for T1 (m3): if the two clients used DIFFERENT galaxies they'd hit
  // different Galaxy DOs, so TOFU never collides and the assertion is vacuously
  // green — proving the *shared* galaxy id is what makes T1 capable-of-failing.
  it('T1-canary: distinct galaxies make the multi-star read vacuously pass', async () => {
    const browser = new Browser();
    const a = uniqueGalaxyScope();
    const b = uniqueGalaxyScope(); // a different galaxy → different Galaxy DO

    const { client: clientA } = await universeAdminClient(
      NebulaClientTest, browser, a.galaxy, a.starA, 'admin@example.com',
    );
    const { client: clientB } = await universeAdminClient(
      NebulaClientTest, browser, b.galaxy, b.starA, 'admin@example.com',
    );

    clientA.callGalaxyGetLatestOntologyVersion(a.galaxy);
    await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
    expect(clientA.lastError).toBeUndefined();

    clientB.callGalaxyGetLatestOntologyVersion(b.galaxy);
    await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
    expect(clientB.lastError).toBeUndefined(); // passes even under TOFU (different DOs)

    clientA[Symbol.dispose]();
    clientB[Symbol.dispose]();
  });

  // ── T3 — Star pre-claim (RED→GREEN) ────────────────────────────────────
  // An attacker authenticated at its own scope addresses a victim's *fresh*
  // Star as the first caller. TOFU would let that first call succeed and pin
  // the Star to the attacker's aud, locking the victim out. Structural derives
  // the scope from the Star's instance name, so the foreign aud is rejected and
  // the victim's later first call still succeeds (no residual lockout, M4).
  it('T3: rejects star pre-claim by a foreign aud; victim not locked out', async () => {
    const attacker = uniqueStar();
    const victimStar = uniqueStar();

    const browserAtk = new Browser();
    const { client: atkClient } = await adminClientAt(
      NebulaClientTest, browserAtk, attacker, attacker, 'attacker@example.com',
    );

    // First-ever call to the fresh victim Star, with the attacker's aud.
    // TOFU: succeeds + pre-claims (RED). Structural: 'Active-scope mismatch'.
    atkClient.callStarWhoAmI(victimStar);
    await vi.waitFor(() => { expect(atkClient.callCompleted).toBe(true); });
    expect(atkClient.lastError).toContain('Active-scope mismatch');
    expect(atkClient.lastResult).toBeUndefined();
    atkClient[Symbol.dispose]();

    // The victim's legitimate first call still succeeds — TOFU would have
    // locked the Star to the attacker's aud and rejected this.
    const browserVic = new Browser();
    const { client: vicClient } = await adminClientAt(
      NebulaClientTest, browserVic, victimStar, victimStar, 'victim@example.com',
    );
    vicClient.callStarWhoAmI(victimStar);
    await vi.waitFor(() => { expect(vicClient.callCompleted).toBe(true); });
    expect(vicClient.lastError).toBeUndefined();
    expect(vicClient.lastResult).toContain('You are');
    vicClient[Symbol.dispose]();
  });

  // ── T2 — Cross-galaxy isolation, capable against the `.*` widening (M9) ──
  // The galaxy/universe pattern widens to `<id>.*`. T2 proves the widening is
  // still a *boundary*: a real, genuinely-minted galaxy-X admin reaches its own
  // Galaxy X but is rejected from a foreign Galaxy Y — and the rejection is the
  // tenant boundary (branch e), not the admin guard. onBeforeCall runs before
  // `requireDominionHere`, so calling an admin method on Y surfaces 'Active-scope
  // mismatch', never 'Admin access required'. Admin-ness is orthogonal.
  it('T2: galaxy admin reaches own Galaxy, rejected from a foreign Galaxy (boundary ≠ admin)', async () => {
    const browser = new Browser();
    const galaxyX = uniqueGalaxyScope().galaxy;
    const galaxyY = uniqueGalaxyScope().galaxy; // a different Galaxy DO

    // Admin at galaxy X (aud = galaxyX, admin = true).
    const { client } = await universeAdminClient(
      NebulaClientTest, browser, galaxyX, galaxyX, 'admin@example.com',
    );

    // Positive: reaches its own Galaxy X (covered by `galaxyX.*`). A fresh Galaxy's
    // config carries the composed Resources plane's coalesce default (the collapse gave
    // Galaxy a data plane; same shared-'config'-key shape a fresh Star has always had).
    client.callGalaxyGetConfig(galaxyX);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeUndefined();
    expect(client.lastResult).toEqual({ coalesceWindowMs: 3600000 });

    // Negative: the SAME admin calls an admin method on foreign Galaxy Y.
    // Tenant boundary rejects before requireDominionHere → 'Active-scope mismatch'.
    client.callGalaxySetConfig(galaxyY, 'k', 'v');
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toContain('Active-scope mismatch');
    expect(client.lastError).not.toContain('Admin');
    client[Symbol.dispose]();
  });

  // ── T6 — Downward dominion: a galaxy admin reaches a descendant Star ────
  // CHANGED (tasks/nebula-onbeforecall-higher-admin-reach.md): a galaxy admin
  // (authScope `<g>`, aud = galaxy) now REACHES a descendant Star via
  // the dominion clause — no aud narrowing needed. (Was rejected with
  // 'Active-scope mismatch' under the aud-only gate.) Capable-of-failing: delete
  // the dominion clause in requirePassage → this goes RED (galaxy aud no longer
  // covers the star's exact pattern).
  it('T6: a galaxy admin reaches a descendant Star (downward dominion)', async () => {
    const browser = new Browser();
    const { galaxy, starA: star } = uniqueGalaxyScope();

    // Galaxy-level admin (aud = galaxy, admin) addressing a descendant Star.
    const { client: galaxyClient } = await universeAdminClient(
      NebulaClientTest, browser, galaxy, galaxy, 'admin@example.com',
    );
    galaxyClient.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(galaxyClient.callCompleted).toBe(true); });
    expect(galaxyClient.lastError).toBeUndefined();
    expect(galaxyClient.lastResult).toContain('You are');
    galaxyClient[Symbol.dispose]();

    // Positive control: the same admin refreshed to the star activeScope (aud =
    // star) also reaches it — now via the unchanged aud path.
    const { client: starClient } = await universeAdminClient(
      NebulaClientTest, browser, galaxy, star, 'admin@example.com',
    );
    starClient.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(starClient.callCompleted).toBe(true); });
    expect(starClient.lastError).toBeUndefined();
    expect(starClient.lastResult).toContain('You are');
    starClient[Symbol.dispose]();
  });

  // ── Dominion (positive): a universe admin reaches a descendant Galaxy + Star ─
  // The headline capability — one `<u>.*` admin identity reaches everything in
  // its dominion with no per-target aud re-mint. (Previously a universe aud
  // matched no galaxy/star pattern, so every descendant call was rejected.)
  it('Dominion: a universe admin reaches a descendant Galaxy and Star', async () => {
    const browser = new Browser();
    const { universe, galaxy, starA: star } = uniqueGalaxyScope();

    // Universe-level admin (aud = universe, admin).
    const { client } = await universeAdminClient(
      NebulaClientTest, browser, universe, universe, 'admin@example.com',
    );

    // Reaches the descendant Galaxy (covered by `<u>.*`; the coalesce default is the
    // composed data plane's config bootstrap — see T2).
    client.callGalaxyGetConfig(galaxy);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeUndefined();
    expect(client.lastResult).toEqual({ coalesceWindowMs: 3600000 });

    // Reaches a descendant Star too.
    client.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeUndefined();
    expect(client.lastResult).toContain('You are');
    client[Symbol.dispose]();
  });

  // ── Exact-star sibling isolation (the post-T6-rewrite anchor for branch e) ─
  // A star-scoped caller (exact pattern `<u>.<g>.tenant-a`) cannot reach a
  // SIBLING star `<u>.<g>.tenant-b`: the exact pattern doesn't cover the
  // sibling, so the dominion clause is skipped and the aud check also misses →
  // branch (e). A within-galaxy isolation case + a clean (e) anchor independent
  // of T6 (which now reaches). Mutation: blank the isAtOrAbove(aud) reject →
  // this passes.
  //
  // ⚠️ The caller is an INVITED MEMBER, not a scope admin. An exact-star
  // `authScope` can only be minted by an invite (the registry's scope row
  // returns the exact id at star tier); `claim-universe` — the only admin-
  // minting path — always yields a universe-tier `<u>.*`. So the dominion clause
  // here is skipped because the caller is non-admin, whereas the original
  // fixture skipped it because an exact-star *admin* pattern missed the sibling.
  // Branch (e) is reached identically either way. The exact-pattern-ADMIN
  // variant is covered by the confinement tests at the bottom of this file
  // (tasks/nebula-confine-admin-bypass.md Phase 1), whose `starAdminPrincipal`
  // reaches an exact-star ADMIN pattern through a real `claimStar` login — no
  // narrowing mint needed.
  it('exact-star caller is rejected reaching a sibling Star (branch e)', async () => {
    const { universe, starA, starB } = uniqueGalaxyScope();

    // Admin at the universe — only needed to issue the invite below.
    const adminBrowser = new Browser();
    await bootstrapAdmin(adminBrowser, universe, 'admin@example.com');
    const { accessToken: adminToken } = await refreshToken(adminBrowser, universe, universe);

    // The caller: invited INTO starA, so authScope is the exact star id.
    const browser = new Browser();
    await createSubject(browser, starA, adminToken, 'member@example.com');
    const { client, payload } = await createInvitedClient(
      NebulaClientTest, browser, starA, starA, 'member@example.com',
    );
    // Guard the fixture itself: if this stopped being an exact-star pattern the
    // test would pass for the wrong reason (a `<u>.*` pattern covers starB).
    expect(payload.access?.authScope).toBe(starA);

    client.callStarWhoAmI(starB);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toContain('Active-scope mismatch');
    client[Symbol.dispose]();
  });

  // ── T-platform — Platform name is not an any-aud sink (M-1) ─────────────
  // `nebula-platform` is the ROOT of the scope tree (covers every name). A tenant DO
  // addressed at that name must be hard-rejected by the isPlatformScope
  // guard (branch b) before the gate could collapse to accept-all.
  // Mutation-validated in Phase 3 (remove branch b → this call succeeds).
  it('T-platform: a tenant DO addressed at "nebula-platform" is rejected for a foreign aud', async () => {
    const browser = new Browser();
    const scope = uniqueStar();
    const { client } = await adminClientAt(
      NebulaClientTest, browser, scope, scope, 'user@example.com',
    );
    client.callUniverseGetConfig('nebula-platform');
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toContain('Active-scope mismatch');
    client[Symbol.dispose]();
  });

  // ── T-malformed — Fail closed on an unparseable tier name (branch d) ────
  // A tier binding addressed with a parseId-rejecting name fails closed because
  // the callee-name parseId throws — observable as a client lastError, not a
  // swallowed 500.
  it('T-malformed: a Star addressed with an unparseable name fails closed', async () => {
    const browser = new Browser();
    const scope = uniqueStar();
    const { client } = await adminClientAt(
      NebulaClientTest, browser, scope, scope, 'user@example.com',
    );

    // 4 dot-segments — parseId rejects (1–3 only).
    client.callStarWhoAmI('a.b.c.d');
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeDefined();
    expect(client.lastError).toContain('dot-separated segments');

    // Illegal slug characters — parseId rejects.
    client.callStarWhoAmI('Bad.app.tenant');
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toContain('Invalid slug');

    client[Symbol.dispose]();
  });
});

// Build a minimal mesh envelope to drive onBeforeCall below the public API
// (which cannot produce a no-aud or no-callee call). The chain is never
// executed — onBeforeCall throws first — so an empty preprocessed chain is fine.
function makeEnvelope(opts: { instanceName?: string; aud?: string }) {
  const callContext: any = { callChain: [], state: {} };
  if (opts.aud) callContext.originAuth = { sub: 'sys', claims: { aud: opts.aud } };
  const metadata: any = {};
  if (opts.instanceName) {
    metadata.callee = { type: 'LumenizeDO', bindingName: 'STAR', instanceName: opts.instanceName };
  }
  return { version: 1, chain: preprocess({}), callContext, metadata };
}

describe('onBeforeCall fail-closed branches (below the public API)', () => {
  // ── T5 — Missing aud / missing callee ──────────────────────────────────
  it('T5: rejects a call with no access claim (branch c)', async () => {
    const name = uniqueStar();
    const stub = (env as any).STAR.getByName(name);
    // Valid callee name (branches a/b/d pass) but no originAuth → no claim, no passage.
    // ⚠️ RE-DERIVED: this used to assert `Missing active scope` on an absent `aud`. That branch
    // died with the `aud` read that justified it — passage is computed from the caller's own
    // `authScope` now, and `hasPassageInto` fails closed by RETURNING false rather than throwing,
    // so an absent claim lands as the ordinary refusal.
    const r = await stub.__executeOperation(makeEnvelope({ instanceName: name }));
    const err = postprocess(r.$error);
    expect(err.message).toContain('Active-scope mismatch');
  });

  it('T5: rejects an envelope missing metadata.callee — instanceName absent (branch a, M7)', async () => {
    const stub = (env as any).STAR.getByName(uniqueStar());
    // No callee metadata → __init never stamps instanceName → branch a, even
    // though an aud is present.
    const r = await stub.__executeOperation(makeEnvelope({ aud: 's-x.app.tenant' }));
    const err = postprocess(r.$error);
    expect(err.message).toContain('missing callee instance name');
  });
});

// Walk a tier DO's own prototype, returning the names of its mesh-callable
// methods whose guard is NOT requireDominionHere (identity comparison — requireDominionHere
// is a single import). Derived dynamically so a newly-added non-admin @mesh
// method changes the set and fails the frozen-allow-list assertion below.
function nonAdminMeshMethods(ctor: { prototype: object }): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (getMeshGuard(fn) === requireDominionHere) continue; // admin-gated → not under the widening concern
    out.push(name);
  }
  return out.sort();
}

describe('Galaxy/Universe widening invariant (B5)', () => {
  // The `.*` widening is sound only if every NON-admin @mesh method on
  // Galaxy/Universe holds galaxy/universe-shared data any descendant star may
  // read. Freeze that set: adding a new non-admin @mesh method fails here,
  // forcing the author to classify it as shared-tenant data (and update this
  // list deliberately). Admin methods sit under the same boundary but their
  // @mesh(requireDominionHere) is the authorization wall, so they're excluded.
  it('B5: Galaxy non-admin @mesh surface equals the frozen shared-data allow-list', () => {
    // Deliberately widened by the collapse: the Galaxy now hosts the chat resource
    // data-plane, so the non-admin surface gains the DAG-gated resource methods, the
    // invite entry, and the broadcast fire-back handlers — the same classification the
    // per-host surface freeze pins in dev-studio/devstudio-resource-surface.test.ts.
    expect(nonAdminMeshMethods(Galaxy)).toEqual([
      'dagTree',
      'getGalaxyConfig',
      'getLatestOntologyVersion',
      'getOntologyVersion',
      'invite',
      'listOntologyVersions',
      'onBroadcastResult',
      'onQueryBroadcastResult',
      'onQuerySubscriberListBroadcastResult',
      // Phase 3 (collapse): the build-completion reload channel — registration is
      // passage-gated like subscribeTree; the fire-back handler rides broadcast.
      'onReloadBroadcastResult',
      'read',
      'subscribe',
      'subscribeQuery',
      'subscribeQuerySubscribers',
      'subscribeReload',
      'transaction',
      'unsubscribe',
      'unsubscribeQuery',
      'unsubscribeQuerySubscribers',
    ]);
  });

  it('B5: Universe non-admin @mesh surface equals the frozen shared-data allow-list', () => {
    expect(nonAdminMeshMethods(Universe)).toEqual(['getUniverseConfig']);
  });
});

describe('gate ignores the inert stored value (T-migration, B2)', () => {
  // The new onBeforeCall never reads `__nebula_universeGalaxyStarId`; the stale
  // value is inert dead data, left in place. Seeding it to the *foreign* aud is
  // the worst case: under a reintroduced compare-and-reject the legit caller
  // would be locked out (i) AND the foreign caller would be pre-claimed in (ii)
  // — so both assertions flip RED if TOFU returns.
  it('name-derived check wins over a stale stored scope; mismatched aud still rejected', async () => {
    const star = uniqueStar();
    const foreign = uniqueStar();

    const browser = new Browser();
    const { client } = await adminClientAt(
      NebulaClientTest, browser, star, star, 'admin@example.com',
    );

    // Seed the legacy TOFU key to the foreign aud (the value that would grant
    // the foreign caller access under TOFU). The seeding call itself is legit
    // (aud === star) so it passes the structural gate.
    client.callStarSeedScopeKey(star, foreign);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeUndefined();

    // (i) aud matches the instance name → accepted, despite the stale stored
    // value mismatching. (Reintroduced TOFU would reject: stored !== aud.)
    client.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeUndefined();
    expect(client.lastResult).toContain('You are');
    client[Symbol.dispose]();

    // (ii) the foreign aud is still rejected, even though the stored value
    // equals it. (Reintroduced TOFU would accept — a pre-claim hijack.)
    const browserF = new Browser();
    const { client: fClient } = await adminClientAt(
      NebulaClientTest, browserF, foreign, foreign, 'evil@example.com',
    );
    fClient.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(fClient.callCompleted).toBe(true); });
    expect(fClient.lastError).toContain('Active-scope mismatch');
    fClient[Symbol.dispose]();
  });
});

describe('framework first-write-wins instanceName guard (T-stamp, m-3 — defense-in-depth)', () => {
  // Soundness rests on name == routing key. The runtime backstop for a name
  // diverging from the address is the framework's setInstanceName guard (not an
  // onBeforeCall branch), reachable only below the public API. Feed an
  // already-stamped DO an envelope whose callee.instanceName diverges and
  // confirm setInstanceName throws (it runs in __init, before onBeforeCall).
  it('a divergent callee.instanceName is rejected by setInstanceName', async () => {
    const routingKey = uniqueStar();
    const stub = (env as any).STAR.getByName(routingKey);

    // First envelope stamps the instance name. ⚠️ It carries NO `access`, so `hasPassageInto` is
    // false and admission would throw — this passes only because `__init`/`setInstanceName` runs
    // BEFORE `onBeforeCall`. Stated because it is a real ordering dependency, not an accident.
    await stub.__executeOperation(makeEnvelope({ instanceName: routingKey, aud: routingKey }));

    // Second envelope to the same DO with a DIVERGENT callee name → the
    // framework's first-write-wins guard (setInstanceName) rejects it. The error
    // is returned wrapped as { $error } (executeEnvelope wraps the whole
    // lifecycle, incl. __init); callRaw would unwrap+rethrow it on the mesh path.
    const divergent = uniqueStar();
    const { $error } = await stub.__executeOperation(
      makeEnvelope({ instanceName: divergent, aud: divergent }),
    );
    expect($error).toBeDefined();
    expect(postprocess($error).message).toMatch(/instance name mismatch/);
  });
});

describe('local-executor path does not invoke onBeforeCall (T-local-skip, B3)', () => {
  // Alarm-delivered self-continuations run via __localChainExecutor, not
  // executeEnvelope, so onBeforeCall must NOT fire. Asserted directly via the
  // onBeforeCall entry marker (count 0 in the post-schedule window) — NOT merely
  // "the continuation completed", which would pass even if the gate fired (the
  // self-continuation carries the star's own aud and would isAtOrAbove-PASS).
  it('an alarm-delivered self-continuation runs without onBeforeCall', async () => {
    const star = uniqueStar();
    const entries: Array<{ namespace: string; data?: { instanceName?: string } }> = [];
    const sink: DebugSink = (e) => { entries.push(e as any); };
    setDebugSink(sink);
    try {
      const browser = new Browser();
      const { client } = await adminClientAt(
        NebulaClientTest, browser, star, star, 'admin@example.com',
      );

      // Scheduling is a mesh entry → onBeforeCall fires for the star here.
      client.callStarScheduleSelfPing(star);
      await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });

      // Clean window: only the alarm's local-executor run should follow.
      entries.length = 0;

      await vi.waitFor(() => {
        expect(entries.some((e) => e.namespace === 'nebula.test.Star.selfPing')).toBe(true);
        // 15s (not the default): this waits on real CF-alarm DELIVERY, whose
        // latency balloons under workerd-zombie CPU starvation in a full parallel
        // run. See .claude/rules/testing.md (alarm-gated waits are contention-fragile).
      }, { timeout: 15000 });

      // The local-executor path invoked onBeforeCall zero times for this star.
      const onBeforeCallForStar = entries.filter(
        (e) => e.namespace === 'nebula.NebulaDO.onBeforeCall' && e.data?.instanceName === star,
      );
      expect(onBeforeCallForStar).toHaveLength(0);

      client[Symbol.dispose]();
    } finally {
      clearDebugSink();
    }
  });
});

// Minimal verified claims — `requirePassage` reads only `access` now, never `aud`. The `aud` on
// these fixtures is deliberate ballast: a regression that resumed reading it would still have to
// get `authScope` right, so leaving it in keeps the fixtures honest rather than convenient.
// (verifyNebulaAccessToken upstream guarantees the rest; the gate never sees an
// unverified token.)
function claims(opts: { aud?: string; authScope?: string; scopeAdmin?: boolean }): NebulaJwtPayload {
  const access: { authScope?: string; scopeAdmin?: boolean } = {};
  if (opts.authScope !== undefined) access.authScope = opts.authScope;
  if (opts.scopeAdmin) access.scopeAdmin = true;
  return { aud: opts.aud, access } as unknown as NebulaJwtPayload;
}

describe('requirePassage (pure shared guard — admin-gated dominion + branch matrix)', () => {
  // This pure function is the single audit point (ADR-007) every Nebula node's
  // onBeforeCall delegates to (all extend NebulaDO). Each branch is
  // mutation-validated here — pure calls, no DO harness — so the integration
  // suites above only need to confirm the wiring.

  // ── Downward dominion (the new clause) — admit a covering ADMIN ──────────
  it('admits a superuser to any tier name (Universe/Galaxy/Star)', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u', authScope: 'nebula-platform', scopeAdmin: true }))).not.toThrow();
    expect(() => requirePassage('u.g', claims({ aud: 'u', authScope: 'nebula-platform', scopeAdmin: true }))).not.toThrow();
    expect(() => requirePassage('u', claims({ aud: 'u', authScope: 'nebula-platform', scopeAdmin: true }))).not.toThrow();
  });
  it('admits a `{u}` admin to {u}.{g} and {u}.{g}.{s}', () => {
    expect(() => requirePassage('u.g', claims({ aud: 'u', authScope: 'u', scopeAdmin: true }))).not.toThrow();
    expect(() => requirePassage('u.g.s', claims({ aud: 'u', authScope: 'u', scopeAdmin: true }))).not.toThrow();
  });
  it('admits a `{u}.{g}.*` admin to {u}.{g}.{s}', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g', authScope: 'u.g', scopeAdmin: true }))).not.toThrow();
  });

  // ── B1 — the admin GATE: position alone is NOT dominion ───────────────────
  // Mutation: drop `access?.scopeAdmin &&` from the dominion clause → the reject below
  // becomes an accept → RED. This is the latent-non-admin-wildcard hole guard.
  it('B1: a covering NON-admin (no access.scopeAdmin) is rejected reaching a descendant', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u', authScope: 'u' /* no scopeAdmin */ })))
      .toThrow('Active-scope mismatch');
  });
  it('B1 control: the SAME covering scope WITH access.scopeAdmin reaches it (admin is the gate)', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u', authScope: 'u', scopeAdmin: true }))).not.toThrow();
  });

  // ── The upward arm (the non-admin path) ──────────────────────────────────
  it('admits a non-admin at or below the name (own scope, and Star→own Galaxy→own Universe)', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.s', authScope: 'u.g.s' }))).not.toThrow();
    expect(() => requirePassage('u.g', claims({ aud: 'u.g.s', authScope: 'u.g.s' }))).not.toThrow();
    expect(() => requirePassage('u', claims({ aud: 'u.g.s', authScope: 'u.g.s' }))).not.toThrow();
  });

  // 🔒 **The headline change: a non-admin reaches its OWN scope and nothing beneath it.**
  // Under the old body the tenant arm read the client-chosen `aud`, so a non-admin at `{u}` could
  // refresh to `aud = {u}.{g}.{s}` and pass at a tenant Star it holds no membership in. Passage is
  // now computed from `authScope`, so this is refused BY CONSTRUCTION — there is no branch to get
  // wrong, because the input the caller controls is no longer read.
  //
  // ⚠️ The `aud` on these fixtures is deliberately the descendant — exactly the value that used to
  // grant it. A regression that restores the `aud` read greens the old behaviour and reds here.
  it('refuses a non-admin BENEATH its own scope, whatever aud it selects', () => {
    expect(() => requirePassage('u.g', claims({ aud: 'u.g', authScope: 'u' })))
      .toThrow('Active-scope mismatch');
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.s', authScope: 'u' })))
      .toThrow('Active-scope mismatch');
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.s', authScope: 'u.g' })))
      .toThrow('Active-scope mismatch');
  });

  // The control that keeps the case above honest: the SAME descent WITH `scopeAdmin` is admitted,
  // so the refusal is about dominion and not about descent being blocked outright.
  it('control: the same descent WITH scopeAdmin is admitted (dominion is the discriminator)', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.s', authScope: 'u', scopeAdmin: true })))
      .not.toThrow();
  });

  // ── Isolation: admin dominion that doesn't cover the target → aud also misses ─
  it('rejects a `{u1}.*` admin reaching {u2} (cross-tenant: pattern miss + aud miss)', () => {
    expect(() => requirePassage('u2.g.s', claims({ aud: 'u1', authScope: 'u1', scopeAdmin: true })))
      .toThrow('Active-scope mismatch');
  });

  // ── Fail-closed branches (each mutation-validated by commenting its line) ──
  it('(a) throws on a missing name', () => {
    expect(() => requirePassage(undefined, claims({ aud: 'u.g.s', authScope: 'u.g.s' })))
      .toThrow('missing callee instance name');
  });
  it('(b) rejects the platform instance name', () => {
    expect(() => requirePassage('nebula-platform', claims({ aud: 'u.g.s', authScope: 'u.g.s' })))
      .toThrow('Active-scope mismatch');
  });
  it('(d) fails closed on an unparseable name', () => {
    expect(() => requirePassage('a.b.c.d', claims({ aud: 'a.b.c.d', authScope: 'a.b.c.d' })))
      .toThrow(/dot-separated segments/);
    expect(() => requirePassage('Bad.app.tenant', claims({ aud: 'Bad.app.tenant', authScope: 'Bad.app.tenant' })))
      .toThrow(/Invalid slug/);
  });
  // ⚠️ **(c) RE-DERIVED, not ported.** The old case asserted `Missing active scope` when `aud` was
  // absent. That throw existed because the tenant arm READ `aud` and would otherwise have compared
  // `undefined`; the arm now reads the caller's own `authScope`, so the justification is gone —
  // and `verify.ts` already refuses any token without an `aud`, so the branch was unreachable from
  // a verified token even before. What survives is the property, on the input that now decides.
  it('(c) an absent aud is simply not read — passage is decided on authScope alone', () => {
    expect(() => requirePassage('u.g.s', claims({ authScope: 'u.g.s' /* no aud */ }))).not.toThrow();
  });
  it('(c) fails closed on an ABSENT access claim — no principal, no passage', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.s' /* no access */ })))
      .toThrow('Active-scope mismatch');
    expect(() => requirePassage('u.g.s', undefined)).toThrow('Active-scope mismatch');
  });
  it('(e) rejects when the caller\'s own scope neither covers nor sits below the name', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.other', authScope: 'u.g.other' })))
      .toThrow('Active-scope mismatch');
  });

  // ── M1 — fail-closed PRECEDENCE: the dominion clause must run AFTER (b)+(d) ───
  // the platform root is at or above any string, so a superuser would short-circuit past
  // these if the clause were placed first. Mutation: move the dominion clause above
  // the platform reject / the callee-name parse → both of these go RED.
  it('M1: a superuser still cannot reach the platform name (b before the dominion clause)', () => {
    expect(() => requirePassage('nebula-platform', claims({ aud: 'u', authScope: 'nebula-platform', scopeAdmin: true })))
      .toThrow('Active-scope mismatch');
  });
  it('M1: a superuser still fails closed on a malformed name (d before the dominion clause)', () => {
    expect(() => requirePassage('a.b.c.d', claims({ aud: 'u', authScope: 'nebula-platform', scopeAdmin: true })))
      .toThrow(/dot-separated segments/);
  });

  // ── m2, RE-FRAMED. It used to read "admitted by the dominion clause; unreachable from a verified
  // token, documented not gated" — an oddity of a body that read `aud` everywhere else. Nothing is
  // special about it now: `aud` is not a passage input at any tier, so an admin without one is
  // admitted for the same reason a non-admin without one is (the (c) pair above). Kept as the
  // admin-side half of that input, since dominion and the upward arm are different code paths. ─
  it('m2: an admin with no aud is admitted — dominion does not consult aud either', () => {
    expect(() => requirePassage('u.g.s', claims({ authScope: 'u', scopeAdmin: true /* no aud */ }))).not.toThrow();
  });
});

// ── The `access.scopeAdmin` confinement (tasks/nebula-confine-admin-bypass.md Phase 1) ──
// The escalation this closes, end to end, with a REAL principal:
//   1. `requirePassage`'s TENANT branch admits a caller whose `aud` sits BELOW this node —
//      intended (a member of a child may reach its parent).
//   2. `requireDominionHere` used to key on the bare `access.scopeAdmin` bit with no reference to which node it
//      was running in → that admitted descendant-scope admin acted as admin on the ANCESTOR.
//
// The principal is a **real star-scoped admin** (`claimStar` stamps `scopeAdmin=1` at the full 3-segment id),
// whose exact-star `authScope` is inert at every ancestor (ADR-015): admitted-but-not-admin at
// the Universe DO, which is the host `driveUniverse` drives. That is exactly the shape the escalation
// needed — reached by a real login rather than by a mint.
//
// ⚠️ This fixture used to narrow a universe admin to `{u}.{g}` through `/mint-narrower-token` passing
// its OWN `sub`. That is SELF-narrowing, which the endpoint now rejects (400) — and it never needed
// the endpoint at all: `foundStarAndLogin` yields the same principal via a real path.
describe('access.scopeAdmin is confined to the node it covers (Phase 1)', () => {
  async function starAdminPrincipal() {
    const browser = new Browser();
    const universe = `conf-${crypto.randomUUID().slice(0, 8)}`;
    const star = `${universe}.app.tenant`;
    const starAdmin = await foundStarAndLogin(browser, star, 'admin@example.com');
    return { universe, star, starAdmin };
  }

  // Drive the Universe DO directly with the star-scoped admin token's REAL claims. Isolated-DO tier: the claims
  // come from a real login; only the transport is synthetic (a NebulaClient refreshes from a
  // Path-scoped cookie at the STAR, so it cannot drive the Universe DO under these claims).
  const driveUniverse = (universe: string, claims: NebulaJwtPayload, method: string, args: unknown[] = []) =>
    (env as any).UNIVERSE.getByName(universe).__executeOperation({
      version: 1,
      chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
      callContext: { callChain: [], state: {}, originAuth: { sub: 'deleg', claims } },
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'UNIVERSE', instanceName: universe } },
    });

  it('the star-scoped admin really is a sub-universe admin (fixture guard)', async () => {
    const { universe, star, starAdmin } = await starAdminPrincipal();
    // If any of these drift the escalation tests below stop testing an escalation at all.
    expect(starAdmin.payload.aud).toBe(star);
    expect(starAdmin.payload.access?.scopeAdmin).toBe(true);
    expect(starAdmin.payload.access?.authScope).toBe(star); // the star itself — never an ancestor
    // ...and it does NOT cover the Universe DO — the whole point.
    expect(isAtOrAbove(star, universe)).toBe(false);
  });

  // ⚠️ Assert the EFFECT, not the returned error. A `@mesh` guard runs POST-ack, so a
  // `requireDominionHere` denial is never in the synchronous response — that silence is the hazard this
  // task documents. Reading the DO's own storage is both the only way to see it and the stronger
  // assertion: it proves no privileged mutation occurred, not merely that a message was produced.
  const readConfig = (universe: string) =>
    (runInDurableObject as any)(
      (env as any).UNIVERSE.getByName(universe),
      (inst: any) => inst.ctx.storage.kv.get('config'),
    );

  it('a star-scoped admin CANNOT setUniverseConfig on the Universe DO (was: full admin)', async () => {
    const { universe, starAdmin } = await starAdminPrincipal();

    // Control: the covering universe admin CAN write — so the DO is reachable and the method works.
    const browser = new Browser();
    const { payload: uniAdmin } = await foundAndLogin(browser, universe, 'admin@example.com', universe);
    await driveUniverse(universe, uniAdmin, 'setUniverseConfig', ['owner', 'universe-admin']);
    await vi.waitFor(async () => expect(await readConfig(universe)).toMatchObject({ owner: 'universe-admin' }));

    // The escalation: same DO, descendant-scope admin, admitted by the tenant branch.
    await driveUniverse(universe, starAdmin.payload, 'setUniverseConfig', ['owner', 'star-admin']);

    // Give the post-ack chain a chance to run, then assert it did NOT take effect.
    // Pre-fix this wrote the descendant's value; post-fix `requireDominionHere` denies before the write.
    await vi.waitFor(async () => expect(await readConfig(universe)).toMatchObject({ owner: 'universe-admin' }));
    expect(await readConfig(universe)).not.toMatchObject({ owner: 'star-admin' });
  });

  it('a star-scoped admin CANNOT teardown the Universe DO (destructive; was: full admin)', async () => {
    const { universe, starAdmin } = await starAdminPrincipal();
    const browser = new Browser();
    const { payload: uniAdmin } = await foundAndLogin(browser, universe, 'admin@example.com', universe);
    await driveUniverse(universe, uniAdmin, 'setUniverseConfig', ['survives', 'yes']);
    await vi.waitFor(async () => expect(await readConfig(universe)).toMatchObject({ survives: 'yes' }));

    await driveUniverse(universe, starAdmin.payload, 'teardown');

    // `teardown` is `ctx.storage.deleteAll()`. Pre-fix the config vanished; post-fix it survives.
    await vi.waitFor(async () => expect(await readConfig(universe)).toMatchObject({ survives: 'yes' }));
  });
});
