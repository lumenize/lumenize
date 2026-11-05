/**
 * `requirePassage`, the guard `ScopedMeshDO`'s passage step runs, as a pure function: a scope name
 * and a call's claims in, a throw or nothing out.
 *
 * Below `/live` because it is the predicate itself, every branch of it, with no running system
 * between the inputs and the verdict; `passage-step.test.ts` and `apps/nebula`'s scope-isolation
 * suite drive the same guard through real logins.
 */
import { describe, it, expect } from 'vitest';
import { requireDominionHere, requirePassage } from '../src/scoped-mesh-do';
import type { AuthClaims } from '../src/auth/types';

// Minimal verified claims. `requirePassage` reads `aud`, the scope of the host the token was minted
// for, and takes the admin bit from the membership (the host rule, ADR-015 and ADR-022); `authScope`
// is the membership the token rests on. verifyAccessToken upstream guarantees the rest, a
// plain membership's `aud` equal to its `authScope` among it, so the gate never sees an unverified
// token.
function claims(opts: { aud?: string; authScope?: string; scopeAdmin?: boolean }): AuthClaims {
  const access: { authScope?: string; scopeAdmin?: boolean } = {};
  if (opts.authScope !== undefined) access.authScope = opts.authScope;
  if (opts.scopeAdmin) access.scopeAdmin = true;
  return { aud: opts.aud, access } as unknown as AuthClaims;
}

describe('requirePassage (pure shared guard — admin-gated dominion + branch matrix)', () => {
  // This pure function is the single audit point (ADR-007) every scoped node's passage step
  // delegates to. Each branch is mutation-validated here — pure calls, no DO harness — so the
  // integration suites only need to confirm the wiring.

  // ── Downward dominion (the new clause) — admit a covering ADMIN ──────────
  it('admits a superuser to any tier name (Universe/Galaxy/Star)', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u', authScope: '_platform', scopeAdmin: true }))).not.toThrow();
    expect(() => requirePassage('u.g', claims({ aud: 'u', authScope: '_platform', scopeAdmin: true }))).not.toThrow();
    expect(() => requirePassage('u', claims({ aud: 'u', authScope: '_platform', scopeAdmin: true }))).not.toThrow();
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
      .toThrow('No passage from "u" into "u.g.s"');
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

  // 🔒 **The host rule: a token reaches from the host it was minted for, never from its membership.**
  // A universe admin's token minted on a tenant's host holds dominion down from that tenant and
  // passage up from it, and nothing beside it. The membership is the same in every line; only the
  // host differs. (A plain member's token never sits below its own scope: verification refuses one,
  // in `scope-verification.test.ts`.)
  it("a universe admin on a tenant's host reaches the tenant, its ancestors by passage, and no sibling", () => {
    const fromTenant = claims({ aud: 'u.g.s', authScope: 'u', scopeAdmin: true });
    expect(() => requirePassage('u.g.s', fromTenant)).not.toThrow();
    expect(() => requirePassage('u.g', fromTenant)).not.toThrow();
    expect(() => requirePassage('u', fromTenant)).not.toThrow();
    expect(() => requirePassage('u.g.other', fromTenant)).toThrow('No passage from "u.g.s" into "u.g.other"');
  });

  it("control: the same membership on the universe's host reaches the sibling (the host decides)", () => {
    expect(() => requirePassage('u.g.other', claims({ aud: 'u', authScope: 'u', scopeAdmin: true }))).not.toThrow();
  });

  // ── Isolation: admin dominion that doesn't cover the target → aud also misses ─
  it('rejects a `{u1}.*` admin reaching {u2} (cross-tenant: pattern miss + aud miss)', () => {
    expect(() => requirePassage('u2.g.s', claims({ aud: 'u1', authScope: 'u1', scopeAdmin: true })))
      .toThrow('No passage from "u1" into "u2.g.s"');
  });

  // ── Fail-closed branches (each mutation-validated by commenting its line) ──
  it('(a) throws on a missing name', () => {
    expect(() => requirePassage(undefined, claims({ aud: 'u.g.s', authScope: 'u.g.s' })))
      .toThrow('missing callee instance name');
  });
  it('(b) rejects the platform instance name', () => {
    expect(() => requirePassage('_platform', claims({ aud: 'u.g.s', authScope: 'u.g.s' })))
      .toThrow('"_platform" is the reserved platform scope, and no call may reach it');
  });
  it('(d) fails closed on an unparseable name', () => {
    expect(() => requirePassage('a.b.c.d', claims({ aud: 'a.b.c.d', authScope: 'a.b.c.d' })))
      .toThrow(/dot-separated segments/);
    expect(() => requirePassage('Bad.app.tenant', claims({ aud: 'Bad.app.tenant', authScope: 'Bad.app.tenant' })))
      .toThrow(/Invalid slug/);
  });
  // (c) The host's scope is the input that decides, so a claim without one is refused, and so is
  // a claim with no membership: no principal, no passage.
  it('(c) fails closed on an absent aud — the host is what passage reads', () => {
    expect(() => requirePassage('u.g.s', claims({ authScope: 'u.g.s' /* no aud */ })))
      .toThrow('No passage from "(no scope)" into "u.g.s"');
  });
  it('(c) fails closed on an ABSENT access claim — no principal, no passage', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.s' /* no access */ })))
      .toThrow('No passage from');
    expect(() => requirePassage('u.g.s', undefined)).toThrow('No passage from "(no scope)" into "u.g.s"');
  });
  it('(e) rejects when the caller\'s own scope neither covers nor sits below the name', () => {
    expect(() => requirePassage('u.g.s', claims({ aud: 'u.g.other', authScope: 'u.g.other' })))
      .toThrow('No passage from "u.g.other" into "u.g.s"');
  });

  // ── M1 — fail-closed PRECEDENCE: the dominion clause must run AFTER (b)+(d) ───
  // the platform root is at or above any string, so a superuser would short-circuit past
  // these if the clause were placed first. Mutation: move the dominion clause above
  // the platform reject / the callee-name parse → both of these go RED.
  it('M1: a superuser still cannot reach the platform name (b before the dominion clause)', () => {
    expect(() => requirePassage('_platform', claims({ aud: 'u', authScope: '_platform', scopeAdmin: true })))
      .toThrow('"_platform" is the reserved platform scope, and no call may reach it');
  });
  it('M1: a superuser still fails closed on a malformed name (d before the dominion clause)', () => {
    expect(() => requirePassage('a.b.c.d', claims({ aud: 'u', authScope: '_platform', scopeAdmin: true })))
      .toThrow(/dot-separated segments/);
  });

  // ── m2: the admin-side half of the (c) pair above, since dominion and the upward arm are
  // different code paths. Dominion reads the host's scope too, so an admin without one has none.
  it('m2: an admin with no aud is refused — dominion reads the host too', () => {
    expect(() => requirePassage('u.g.s', claims({ authScope: 'u', scopeAdmin: true /* no aud */ })))
      .toThrow('No passage from "(no scope)" into "u.g.s"');
  });
});

describe('requireDominionHere fails closed', () => {
  // A node with no instance name, a `MeshWorker`, names no node to hold dominion over.
  it('on a node with no instance name, before reading any claim', () => {
    const node = { lmz: { callContext: { callChain: [], originAuth: { sub: 's', claims: { aud: 'u', access: { authScope: 'u', scopeAdmin: true } } } } } };
    expect(() => requireDominionHere(node as never)).toThrow('Admin check failed: missing callee instance name');
  });
});
