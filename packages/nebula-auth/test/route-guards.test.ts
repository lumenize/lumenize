/**
 * The route pipeline's guard chain on the platform host. Every invite enters mesh-side through the
 * NebulaAuthFacade, whose eligibility/cap verdicts are asserted with distinguishable messages in
 * apps/nebula's baseline lane (`invite-facade.test.ts`), and no route reads an access token, so what
 * remains here is the pipeline itself: the refresh's host parse, the connection limiter,
 * per-request state, the forward terminals, and the table-is-the-registration properties.
 *
 * Grounding: rung 2 (test-mode server issuance) via the shared helpers — real claim → consume →
 * refresh loops, so `authScope`/`scopeAdmin` are server-decided, never fixture-built.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { WS_TOKEN_PREFIX } from '@lumenize/mesh/client';
import { env } from 'cloudflare:test';
import {
  foundUniverse, foundStarAndLogin, inviteAndLogin, verifiedClaims, authUrl, refreshCookie, PLATFORM,
} from './test-helpers';
import { mintImpersonationToken } from '../src/worker-token';
import { recordingHooks } from './test-worker-and-dos';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

let sink: any[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

/** Entries the Registry DO emitted after `mark` — the "was the singleton entered?" oracle. */
function registryEntriesSince(mark: number): any[] {
  return sink.slice(mark).filter((e) => String(e.namespace).startsWith('nebula-auth.Registry.'));
}

describe('a host the parse refuses is refused at the edge and never reaches the singleton', () => {
  // The containment predicates are grammar-free string math, so the host parse is the only thing
  // refusing a scope no grammar can produce before it reaches a candidate cookie or the singleton.
  it('a refresh from a four-deep host → 403 invalid_origin, never a 500, and the Registry is not entered', async () => {
    const u = uni();
    const { refreshToken } = await foundUniverse(SELF, u, `deep-${u}@example.com`);
    const mark = sink.length;
    const resp = await SELF.fetch(new Request(authUrl('refresh-token'), {
      method: 'POST',
      headers: { Origin: `http://extra.tenant.app.${u}.lumenize.localhost`, Cookie: refreshCookie(u, refreshToken) },
    }));
    expect(resp.status).toBe(403);
    expect((await resp.json() as any).error).toBe('invalid_origin');
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });
});

describe('the impersonation mint refuses a non-admin with the SAME refusal as an absent subject', () => {
  it('a member is refused — the collapsed refusal, after the lookup', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    const other = await inviteAndLogin(SELF, scope, admin.access_token, 'other@example.com');

    const mark = sink.length;
    const minted = await mintImpersonationToken(env as Env, await verifiedClaims(member.access_token), other.parsed.sub);
    expect(minted).toEqual({ ok: false, message: `The calling host's scope "${scope}" does not administer this subject` });
    // The lookup DOES run (canMintFor needs the subject's scope); what closes the probing concern is
    // the collapsed refusal — asserted equal in impersonation-mint.test.ts § refusal and absence
    // are indistinguishable. The marker assertion is the positive direction here.
    const lookups = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.getIdentityScope');
    expect(lookups).toHaveLength(1);
  });
});

describe('route registration is the table', () => {
  it('an unrecognized authenticated-looking suffix returns 404 and reaches no handler', async () => {
    const u = uni();
    // No Bearer: a route dispatched to an authenticated handler would answer 401; 404 proves the
    // suffix has no entry in the route table (the retired dispatch's catch-all sent any
    // unrecognized authenticated suffix to the narrower-token mint).
    const noAuth = await SELF.fetch(new Request(authUrl(`${u}/frob-token`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(noAuth.status).toBe(404);

    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const withAuth = await SELF.fetch(new Request(authUrl(`${u}/frob-token`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }));
    expect(withAuth.status).toBe(404);
  });

  it('the deleted /invite row is ABSENT, not verb-shifted: both verbs 404', async () => {
    const u = uni();
    // A row that had merely lost its POST handler would answer 405 with an Allow header; a row
    // that does not exist reaches no handler under any verb. Part of the no-HTTP-invite-surface
    // structural inventory.
    expect((await SELF.fetch(new Request(authUrl(`${u}/invite`), { method: 'GET' }))).status).toBe(404);
    expect((await SELF.fetch(new Request(authUrl(`${u}/invite`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }))).status).toBe(404);
  });
});

describe('an upgrade never reaches a POST route', () => {
  // Measured in this lane: the SELF.fetch hop rewrites a request carrying `Upgrade: websocket` to a
  // GET upgrade, so a POST-only route answers it 405 from the table — what a real ingress upgrade
  // gets too.
  it('an Upgrade-carrying request to a POST route arrives as a GET upgrade and 405s at the edge', async () => {
    const upgraded = await SELF.fetch(new Request(authUrl('home-summary'), {
      method: 'POST', // rewritten to GET by the upgrade machinery
      headers: { 'Content-Type': 'application/json', Upgrade: 'websocket' },
      body: '{}',
    }));
    expect(upgraded.status).toBe(405);
  });
});

describe('per-request state', () => {
  it('two concurrent requests get their own verdicts', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `prs-admin-${u}@example.com`);
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, `prs-star-${u}@example.com`, admin.access_token);
    const member = await inviteAndLogin(SELF, star, admin.access_token, `prs-member-${u}@example.com`);

    // Reds against per-request state parked at module scope in a reused isolate — one request's
    // cookies answering the other's summary would put the wrong person's memberships in one of these.
    const summaryOf = (cookie: string) => SELF.fetch(new Request(authUrl('home-summary'), {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    })).then(async (r) => {
      expect(r.status).toBe(200);
      const body = await r.json() as { groups: { summary: { emails: { memberships: { scope: string }[] }[] } }[] };
      return body.groups.flatMap((g) => g.summary.emails.flatMap((e) => e.memberships.map((m) => m.scope)));
    });
    const [adminScopes, memberScopes] = await Promise.all([
      summaryOf(refreshCookie(u, admin.refreshToken)), summaryOf(refreshCookie(star, member.refreshToken)),
    ]);
    expect(adminScopes).toEqual([u]);
    expect(memberScopes).toEqual([star]);
    expect(starAdmin.parsed.access.authScope).toBe(star); // fixture guard: a second person at the star
  });
});

describe('the table is the sole registration — every route in it', () => {
  it('every entry declares a method — asserted over the exported table, so a new row inherits it', async () => {
    const { buildAuthRouteTable } = await import('../src/router');
    const { env } = await import('cloudflare:test');
    const table = buildAuthRouteTable(env as any, recordingHooks);
    expect(table.length).toBeGreaterThan(0); // the assertion below is vacuous over an empty table
    for (const entry of table) {
      // The runner treats an absent method as ANY verb — silently permissive on every one of
      // these single-verb routes.
      expect(entry.method, entry.path).toBeDefined();
    }
  });

  it('a wrong verb answers 405 from the edge on routes that used to fall through', async () => {
    // logout / refresh-token / home-summary each pass every other criterion while accepting any
    // verb if their entry drops its method.
    expect((await SELF.fetch(new Request(authUrl('logout'), { method: 'PUT' }))).status).toBe(405);
    expect((await SELF.fetch(new Request(authUrl('refresh-token'), { method: 'GET' }))).status).toBe(405);
    expect((await SELF.fetch(new Request(authUrl('home-summary'), { method: 'GET' }))).status).toBe(405);
  });

  it('a throwaway suffix on the SCOPE-LESS family also 404s (no enumeration survives beside the table)', async () => {
    expect((await SELF.fetch(new Request(authUrl('frob'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }))).status).toBe(404);
  });
});

describe('no request the edge is going to REFUSE reaches the singleton', () => {
  it('GET /auth/claim-universe answers 405 at the edge and the Registry is never entered', async () => {
    // Positive control FIRST: a request the edge admits does emit the entry marker — otherwise the
    // absence below is the marker being broken, not the singleton being protected.
    // ⚠️ **A POST-GATE-FAILING request, and it has to be.** This probe wants "the edge admitted it
    // and the singleton was entered" — nothing more — and every surviving open row MINTS or SENDS
    // MAIL when it succeeds (`discover`, which answered 200 and wrote nothing, is retired). So the
    // request passes every edge check and is refused by the DO's own slug grammar: the marker is
    // emitted, and no universe is claimed. The STATUS is incidental here; the sink is the assertion.
    const admitted = await SELF.fetch(new Request(authUrl('claim-universe'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'Not A Valid Slug', email: 'entry-probe@example.com' }),
    }));
    expect(admitted.status).toBe(400);
    expect(sink.filter((e) => e.namespace === 'nebula-auth.Registry.fetch').length).toBeGreaterThan(0);

    const mark = sink.length;
    const refused = await SELF.fetch(new Request(authUrl('claim-universe'), { method: 'GET' }));
    // An edge 405 and a DO 405 are identical to the caller — the sink is what distinguishes them.
    // Reds against the old forward-before-checking, which woke the singleton with a bare GET,
    // unauthenticated and unrate-limited (ADR-018: an anonymous path to the one DO is an outage).
    expect(refused.status).toBe(405);
    expect(sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.fetch')).toHaveLength(0);
  });
});

describe('each forward terminal preserves what its row is allowed to touch', () => {
  it('an OPEN row forwards RAW: an arbitrary header reaches the DO, and a malformed body gets the DO\'s own 400', async () => {
    // Header fidelity — reds against collapsing the terminals into one rebuild, which drops every
    // header but Content-Type while leaving every status-only assertion green.
    const mark = sink.length;
    // Same post-gate-failing shape as above: the header has to REACH the DO, which a raw forward
    // does and a rebuild does not — whether the DO then likes the slug is beside the point.
    const withHeader = await SELF.fetch(new Request(authUrl('claim-universe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forward-fidelity-probe': '1' },
      body: JSON.stringify({ slug: 'Not A Valid Slug', email: 'fidelity-probe@example.com' }),
    }));
    expect(withHeader.status).toBe(400);
    const entries = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.fetch');
    expect(entries).toHaveLength(1);
    expect(entries[0].data.headerNames).toContain('x-forward-fidelity-probe');

    // Body fidelity — a rebuild absorbs malformed JSON into `{}` at the edge, so the DO would
    // answer a field-level 400 instead of its own JSON guard's `invalid_request`.
    const malformed = await SELF.fetch(new Request(authUrl('claim-universe'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json{',
    }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error).toBe('invalid_request');
  });
});

describe('the connection-keyed limiter actually bounds an anonymous caller', () => {
  it('cookie-less logout POSTs from ONE connection loop past the limit and 429; the Registry is not entered', async () => {
    // Driven through routeNebulaAuthRequest directly so the CF-Connecting-IP header survives (the
    // fetch hop may not preserve a trusted header), keyed to a unique IP so no other test shares
    // the bucket. Reds against declaring the guard and never declaring its binding — a no-op that
    // greens everything.
    const { routeNebulaAuthRequest } = await import('../src/router');
    const { env } = await import('cloudflare:test');
    const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const mark = sink.length;
    let limited: Response | undefined;
    // 250, not 101 — the simulator's fixed 60s window can roll over mid-loop, splitting the requests
    // across two windows; 250 guarantees 101+ land in ONE window either way.
    for (let i = 0; i < 250; i++) {
      const resp = await routeNebulaAuthRequest(new Request(authUrl('logout'), {
        method: 'POST', headers: { 'CF-Connecting-IP': ip },
      }), env as any, { hooks: recordingHooks });
      if (resp!.status === 429) { limited = resp; break; }
      expect(resp!.status).toBe(200);
    }
    expect(limited).toBeDefined();
    expect((await limited!.json() as any).error).toBe('rate_limited');
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });

  it('the control: with NO CF-Connecting-IP header the key does not collapse to a constant (no 429s)', async () => {
    // Reds if the absent-header fallback becomes a shared constant key — which would also 429 the
    // whole suite into what look like auth failures.
    for (let i = 0; i < 120; i++) {
      const resp = await SELF.fetch(new Request(authUrl('logout'), { method: 'POST' }));
      expect(resp.status).toBe(200);
    }
  });
});

// (The old "a superuser passes every instance-scoped route" describe rode the deleted /invite row —
// there is no JWT-bearing instance-scoped route left for it to exercise. The root-branch property
// keeps two homes: the impersonation mint's platform limbs in impersonation-mint.test.ts, and the
// invite facade's platform-tier limb in apps/nebula's invite-facade.test.ts.)
