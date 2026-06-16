/**
 * Structural DO scope isolation (Fix 1) — tier DOs Star / Galaxy / Universe.
 *
 * NebulaDO.onBeforeCall accepts a mesh call iff its `aud` is covered by the
 * scope encoded in the DO's *instance name* (`buildAuthScopePattern(name)` →
 * `matchAccess(pattern, aud)`), replacing the old trust-on-first-use `aud`-lock.
 *
 * Every test here is capable-of-failing: it flips RED if the gate reverts to
 * TOFU (first-caller-wins) or drops the structural check.
 *
 * @see tasks/nebula-do-scope-isolation.md (the test matrix)
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugSink } from '@lumenize/debug';
import { Galaxy, Universe, requireAdmin } from '@lumenize/nebula';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import {
  createAuthenticatedClient,
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

    // One founder-admin at the galaxy; two clients at sibling star activeScopes.
    // Both clients share the single Galaxy DO `galaxy` — the collision under test.
    const { client: clientA } = await createAuthenticatedClient(
      NebulaClientTest, browser, galaxy, starA, 'admin@example.com',
    );
    const { client: clientB } = await createAuthenticatedClient(
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

    const { client: clientA } = await createAuthenticatedClient(
      NebulaClientTest, browser, a.galaxy, a.starA, 'admin@example.com',
    );
    const { client: clientB } = await createAuthenticatedClient(
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
    const { client: atkClient } = await createAuthenticatedClient(
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
    const { client: vicClient } = await createAuthenticatedClient(
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
  // `requireAdmin`, so calling an admin method on Y surfaces 'Active-scope
  // mismatch', never 'Admin access required'. Admin-ness is orthogonal.
  it('T2: galaxy admin reaches own Galaxy, rejected from a foreign Galaxy (boundary ≠ admin)', async () => {
    const browser = new Browser();
    const galaxyX = uniqueGalaxyScope().galaxy;
    const galaxyY = uniqueGalaxyScope().galaxy; // a different Galaxy DO

    // Founder admin at galaxy X (aud = galaxyX, admin = true).
    const { client } = await createAuthenticatedClient(
      NebulaClientTest, browser, galaxyX, galaxyX, 'admin@example.com',
    );

    // Positive: reaches its own Galaxy X (covered by `galaxyX.*`).
    client.callGalaxyGetConfig(galaxyX);
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toBeUndefined();
    expect(client.lastResult).toEqual({});

    // Negative: the SAME admin calls an admin method on foreign Galaxy Y.
    // Tenant boundary rejects before requireAdmin → 'Active-scope mismatch'.
    client.callGalaxySetConfig(galaxyY, 'k', 'v');
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toContain('Active-scope mismatch');
    expect(client.lastError).not.toContain('Admin');
    client[Symbol.dispose]();
  });

  // ── T6 — Tier mismatch (m1/m2) ─────────────────────────────────────────
  // A galaxy-level aud calling a Star is rejected — the Star's exact pattern
  // requires the star-level aud. Positive control: the same admin refreshed to
  // the star activeScope (aud = star) is accepted.
  it('T6: galaxy-level aud calling a Star is rejected; star-level aud accepted', async () => {
    const browser = new Browser();
    const { galaxy, starA: star } = uniqueGalaxyScope();

    // Galaxy-level founder admin (aud = galaxy) addressing a Star → rejected.
    const { client: galaxyClient } = await createAuthenticatedClient(
      NebulaClientTest, browser, galaxy, galaxy, 'admin@example.com',
    );
    galaxyClient.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(galaxyClient.callCompleted).toBe(true); });
    expect(galaxyClient.lastError).toContain('Active-scope mismatch');
    galaxyClient[Symbol.dispose]();

    // Positive control: same admin refreshes activeScope to the star (aud = star).
    const { client: starClient } = await createAuthenticatedClient(
      NebulaClientTest, browser, galaxy, star, 'admin@example.com',
    );
    starClient.callStarWhoAmI(star);
    await vi.waitFor(() => { expect(starClient.callCompleted).toBe(true); });
    expect(starClient.lastError).toBeUndefined();
    expect(starClient.lastResult).toContain('You are');
    starClient[Symbol.dispose]();
  });

  // ── T-platform — Platform name is not an any-aud sink (M-1) ─────────────
  // `buildAuthScopePattern('nebula-platform')` is `*` (accept-all). A tenant DO
  // addressed at that name must be hard-rejected by the isPlatformInstance
  // guard (branch b) before the gate could collapse to accept-all.
  // Mutation-validated in Phase 3 (remove branch b → this call succeeds).
  it('T-platform: a tenant DO addressed at "nebula-platform" is rejected for a foreign aud', async () => {
    const browser = new Browser();
    const scope = uniqueStar();
    const { client } = await createAuthenticatedClient(
      NebulaClientTest, browser, scope, scope, 'user@example.com',
    );
    client.callUniverseGetConfig('nebula-platform');
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect(client.lastError).toContain('Active-scope mismatch');
    client[Symbol.dispose]();
  });

  // ── T-malformed — Fail closed on an unparseable tier name (branch d) ────
  // A tier binding addressed with a parseId-rejecting name fails closed because
  // buildAuthScopePattern throws — observable as a client lastError, not a
  // swallowed 500.
  it('T-malformed: a Star addressed with an unparseable name fails closed', async () => {
    const browser = new Browser();
    const scope = uniqueStar();
    const { client } = await createAuthenticatedClient(
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
  it('T5: rejects a call with no aud (branch c)', async () => {
    const name = uniqueStar();
    const stub = (env as any).STAR.getByName(name);
    // Valid callee name (branches a/b/d pass) but no originAuth → branch c.
    const r = await stub.__executeOperation(makeEnvelope({ instanceName: name }));
    const err = postprocess(r.$error);
    expect(err.message).toContain('Missing active scope');
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
// methods whose guard is NOT requireAdmin (identity comparison — requireAdmin
// is a single import). Derived dynamically so a newly-added non-admin @mesh
// method changes the set and fails the frozen-allow-list assertion below.
function nonAdminMeshMethods(ctor: { prototype: object }): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (getMeshGuard(fn) === requireAdmin) continue; // admin-gated → not under the widening concern
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
  // @mesh(requireAdmin) is the authorization wall, so they're excluded.
  it('B5: Galaxy non-admin @mesh surface equals the frozen shared-data allow-list', () => {
    expect(nonAdminMeshMethods(Galaxy)).toEqual([
      'getGalaxyConfig',
      'getLatestOntologyVersion',
      'getOntologyVersion',
      'listOntologyVersions',
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
    const { client } = await createAuthenticatedClient(
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
    const { client: fClient } = await createAuthenticatedClient(
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

    // First envelope stamps the instance name (onBeforeCall passes: aud === name).
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
  // self-continuation carries the star's own aud and would matchAccess-PASS).
  it('an alarm-delivered self-continuation runs without onBeforeCall', async () => {
    const star = uniqueStar();
    const entries: Array<{ namespace: string; data?: { instanceName?: string } }> = [];
    const sink: DebugSink = (e) => { entries.push(e as any); };
    setDebugSink(sink);
    try {
      const browser = new Browser();
      const { client } = await createAuthenticatedClient(
        NebulaClientTest, browser, star, star, 'admin@example.com',
      );

      // Scheduling is a mesh entry → onBeforeCall fires for the star here.
      client.callStarScheduleSelfPing(star);
      await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });

      // Clean window: only the alarm's local-executor run should follow.
      entries.length = 0;

      await vi.waitFor(() => {
        expect(entries.some((e) => e.namespace === 'nebula.test.Star.selfPing')).toBe(true);
      }, { timeout: 8000 });

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
