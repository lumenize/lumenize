/**
 * The route pipeline's guard chain on the two authenticated instance routes (`/invite`,
 * `/mint-narrower-token`): every entry states its complete requirement, `passage` and `dominion`
 * are computed by calling the predicates, and the refusal names WHICH rule failed.
 *
 * Grounding: rung 2 (test-mode server issuance) via the shared helpers — real claim → click →
 * refresh loops, so `authScope`/`scopeAdmin` are server-decided, never fixture-built. The one
 * hand-mint (`createNebulaTestToken`) is confined to the WS-subprotocol carrier test, which needs
 * only a validly-signed token.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { WS_TOKEN_PREFIX } from '@lumenize/mesh/client';
import {
  foundUniverse, foundStarAndLogin, inviteAndLogin, adminRequest, mintNarrowerRequest, url, platformLogin,
  BOOTSTRAP_EMAIL,
} from './test-helpers';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

let sink: any[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

/** Entries the Registry DO emitted after `mark` — the "was the singleton entered?" oracle. */
function registryEntriesSince(mark: number): any[] {
  return sink.slice(mark).filter((e) => String(e.namespace).startsWith('nebula-auth.Registry.'));
}

describe('upward refusal — a scopeAdmin at {u}.{g}.{s} is refused above its own scope', () => {
  // Reds against a mechanical passage-only swap that leaves no dominion guard behind: passage
  // admits upward for free, so a star admin would mint identities at the Universe.
  it('refused at /auth/{u}/invite AND /auth/{u}.{g}/invite — by DOMINION, with insufficient_scope', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, 'star-admin@example.com', admin.access_token);
    expect(starAdmin.parsed.access.scopeAdmin).toBe(true); // fixture guard — else the refusals below are about the bit, not the direction

    for (const target of [u, `${u}.app`]) {
      const resp = await adminRequest(SELF, target, 'invite', starAdmin.access_token, {
        method: 'POST', body: { emails: ['x@example.com'] },
      });
      expect(resp.status).toBe(403);
      const body = await resp.json() as { error: string; error_description: string };
      // `insufficient_scope`, not `forbidden`: the caller HOLDS scopeAdmin — the refusal names the
      // rule that actually failed (dominion over the addressed scope), which a passage refusal or a
      // bare-bit refusal would misname.
      expect(body.error).toBe('insufficient_scope');
      expect(body.error_description).toBe(`Token scope "${star}" does not administer "${target}"`);
    }
  });

  it('...and still passes its OWN scope (the refusal is about direction, not the token)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, 'star-admin2@example.com', admin.access_token);
    const own = await adminRequest(SELF, star, 'invite', starAdmin.access_token, {
      method: 'POST', body: { emails: ['peer@example.com'] },
    });
    expect(own.status).toBe(200);
  });
});

describe('a refusal names WHICH rule failed — three codes across two guards', () => {
  it('passageGuard: a cross-universe admin gets insufficient_scope with the passage message, and the denied log names the route', async () => {
    const a = uni();
    const admin = await foundUniverse(SELF, a, 'admin-a@example.com');
    const other = `${uni()}.app`;
    const mark = sink.length;
    const resp = await adminRequest(SELF, other, 'invite', admin.access_token, {
      method: 'POST', body: { emails: ['x@example.com'] },
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string; error_description: string };
    expect(body.error).toBe('insufficient_scope');
    expect(body.error_description).toBe(`Token scope "${a}" has no passage into "${other}"`);

    const denied = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.router.guard.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].data.route).toBe(`/auth/${other}/invite`); // the SHARED log says which route denied
    expect(denied[0].data.rule).toBe('passage');
  });

  it('dominionOverScopeGuard: a non-admin gets forbidden; the denied log names the route and the rule', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    expect(member.parsed.access.scopeAdmin).toBeUndefined(); // fixture guard

    const mark = sink.length;
    const resp = await adminRequest(SELF, scope, 'invite', member.access_token, {
      method: 'POST', body: { emails: ['x@example.com'] },
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string; error_description: string };
    expect(body.error).toBe('forbidden'); // lacks the authority outright — NOT insufficient_scope
    expect(body.error_description).toBe(
      `Admin access required: token scope "${scope}" holds no scopeAdmin over "${scope}"`);

    const denied = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.router.guard.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].data.route).toBe(`/auth/${scope}/invite`);
    expect(denied[0].data.rule).toBe('dominion');
    expect(denied[0].data.code).toBe('forbidden');
  });
});

describe('a malformed scope segment is refused at the edge and never reaches the singleton', () => {
  // A VALID admin token rides along deliberately: without `parseScopeGuard` the request would
  // proceed into the guard chain (and for the 4-segment case, all the way to the handler, because
  // `isAtOrAbove` is grammar-free string math) — so dropping the parse step reds these on status.
  it('POST /auth/bad..name/invite → 400 invalid_instance, Registry not entered', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const mark = sink.length;
    const resp = await adminRequest(SELF, 'bad..name', 'invite', admin.access_token, {
      method: 'POST', body: { emails: ['x@example.com'] },
    });
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_instance');
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });

  it('the CREATE case: /auth/{u}.{g}.{s}.{x}/invite is refused BY THE PARSE — a scope no grammar can produce', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const fourSegment = `${u}.app.tenant.extra`;
    const mark = sink.length;
    // Containment string math would ACCEPT this (isAtOrAbove(u, u.g.s.x) is true), so only the
    // grammar refuses it — which is exactly why the parse is a step, not something implicit.
    const resp = await adminRequest(SELF, fourSegment, 'invite', admin.access_token, {
      method: 'POST', body: { emails: ['x@example.com'] },
    });
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_instance');
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });

  it('the mint route is SCOPE-LESS, so a scoped mint path — malformed or not — is 404, not a route', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const mark = sink.length;
    for (const segment of ['bad..name', u]) {
      const resp = await SELF.fetch(new Request(url(segment, 'mint-narrower-token'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subOfNarrowerToken: 'x', activeScope: u }),
      }));
      expect(resp.status, segment).toBe(404);
    }
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });
});

describe('the mint refuses a non-admin with the SAME body as an absent subject', () => {
  it('a member is refused 403 forbidden — the collapsed refusal, after the lookup', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    const other = await inviteAndLogin(SELF, scope, admin.access_token, 'other@example.com');

    const mark = sink.length;
    const resp = await mintNarrowerRequest(SELF, member.access_token, { subOfNarrowerToken: other.parsed.sub, activeScope: scope });
    expect(resp.status).toBe(403);
    expect((await resp.json() as any).error).toBe('forbidden');
    // The lookup DOES run on the scope-less route (canMintFor needs the subject's scope); what
    // closes the probing concern is the collapsed refusal — asserted byte-for-byte in
    // mint-narrower-token.test.ts § refusal and absence are indistinguishable — plus the
    // sub-keyed limiter ahead of the handler. The marker assertion is the positive direction here.
    const lookups = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.getIdentityScope');
    expect(lookups).toHaveLength(1);
  });
});

describe('route registration is the table', () => {
  it('an unrecognized authenticated-looking suffix returns 404 and reaches no handler', async () => {
    const u = uni();
    // No Bearer: a route dispatched to an authenticated handler would answer 401; 404 proves the
    // suffix has no entry in the route table (the retired dispatch's catch-all sent any
    // unrecognized authenticated suffix to /mint-narrower-token).
    const noAuth = await SELF.fetch(new Request(url(u, 'frob-token'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(noAuth.status).toBe(404);

    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const withAuth = await adminRequest(SELF, u, 'frob-token', admin.access_token, {
      method: 'POST', body: {},
    });
    expect(withAuth.status).toBe(404);
  });

  it('a wrong verb on a table route answers 405 from the edge with Allow (was a 404 fall-through)', async () => {
    const u = uni();
    const resp = await SELF.fetch(new Request(url(u, 'invite'), { method: 'GET' }));
    expect(resp.status).toBe(405);
    expect(resp.headers.get('Allow')).toContain('POST');
  });
});

describe('the token carrier is the Authorization header alone', () => {
  // Reds against a verifyJwtGuard that carries the retired either/or WebSocket extraction across —
  // the token VERIFIES under that mutation, so every verdict-only assertion would stay green while
  // the request reached the handler (200 here, vs the 401 asserted).
  //
  // ⚠️ The POST+Upgrade shape is driven through routeNebulaAuthRequest DIRECTLY (the
  // nebula-auth-cors.test.ts pattern): measured in this lane, the SELF.fetch hop rewrites a
  // request carrying `Upgrade: websocket` to a GET upgrade (constructed POST, arrived non-POST),
  // so through fetch the shape under test cannot reach the router at all — asserted below as its
  // own limb, since that 405 is what a real ingress upgrade gets from the table.
  it('a VALID token in the WebSocket subprotocol is refused 401; the same token via Authorization succeeds', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');

    const { routeNebulaAuthRequest } = await import('../src/router');
    const { env } = await import('cloudflare:test');
    const viaSubprotocol = await routeNebulaAuthRequest(new Request(url(u, 'invite'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `${WS_TOKEN_PREFIX}${admin.access_token}`,
      },
      body: JSON.stringify({ emails: ['x@example.com'] }),
    }), env as any);
    expect(viaSubprotocol?.status).toBe(401);

    // The carrier, not the token, is what the refusal is about. (The Gateway's own subprotocol
    // path is untouched: `apps/nebula/src/entrypoint.ts` reads it directly on `/gateway`, and every
    // apps/nebula test-app connects through it — that suite is the Gateway limb's standing coverage.)
    const viaBearer = await adminRequest(SELF, u, 'invite', admin.access_token, {
      method: 'POST', body: { emails: ['carrier-check@example.com'] },
    });
    expect(viaBearer.status).toBe(200);
  });

  it('through the fetch hop, an Upgrade-carrying request arrives as a GET upgrade and 405s at the edge', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const upgraded = await SELF.fetch(new Request(url(u, 'invite'), {
      method: 'POST', // rewritten to GET by the upgrade machinery — see the describe comment
      headers: {
        'Content-Type': 'application/json',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `${WS_TOKEN_PREFIX}${admin.access_token}`,
      },
      body: JSON.stringify({ emails: ['x@example.com'] }),
    }));
    expect(upgraded.status).toBe(405);
  });
});

describe('per-request state', () => {
  it('two concurrent requests get their own verdicts', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, 'star-admin@example.com', admin.access_token);

    // Reds against per-request claims parked at module scope in a reused isolate — one request's
    // claims deciding the other's verdict would flip exactly one of these.
    const [ownScope, upward] = await Promise.all([
      adminRequest(SELF, u, 'invite', admin.access_token, {
        method: 'POST', body: { emails: ['a@example.com'] },
      }),
      adminRequest(SELF, u, 'invite', starAdmin.access_token, {
        method: 'POST', body: { emails: ['b@example.com'] },
      }),
    ]);
    expect(ownScope.status).toBe(200);
    expect(upward.status).toBe(403);
  });
});

describe('ADR-016 through the pipeline', () => {
  it('an invite issued under a DERIVED token records the full acting principal', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, 'star-admin@example.com', admin.access_token);

    const minted = await mintNarrowerRequest(SELF, admin.access_token, { subOfNarrowerToken: starAdmin.parsed.sub, activeScope: star });
    expect(minted.status).toBe(200);
    const narrower = (await minted.json() as any).access_token;

    const mark = sink.length;
    const resp = await adminRequest(SELF, star, 'invite', narrower, {
      method: 'POST', body: { emails: ['invitee@example.com'] },
    });
    expect(resp.status).toBe(200);

    const sent = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.invite.sent');
    expect(sent).toHaveLength(1);
    const acting = sent[0].data.actingToken;
    // All four elements, separately — a routeState narrowed to `access`, or a hand-reconstructed
    // partial claims object, type-checks and projects a wrong-but-believed record missing some.
    expect(acting.sub).toBe(starAdmin.parsed.sub);                                    // the subject
    expect(acting.act).toEqual({ sub: admin.parsed.sub, profileId: admin.parsed.profileId }); // who drove
    expect(acting.profileId).toBe(starAdmin.parsed.profileId);
    expect(acting.access).toEqual({ authScope: star, scopeAdmin: true });
  });
});

describe('the rate limiter survives the decomposition', () => {
  it('repeated /invite POSTs under one sub loop past the declared limit and answer 429 rate_limited', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    // The shared binding is 100/60 (test wrangler.jsonc) — deliberately NOT lowered, since six
    // files make repeated Bearer calls against it. Loop past it, as packages/auth's precedent does;
    // an empty `emails` array keeps each pass cheap (the guard chain is what is under test).
    // ⚠️ The cap is 250, not 101: the simulator's fixed 60s window can roll over mid-loop, splitting
    // the requests across two windows — 250 guarantees 101+ land in ONE window either way.
    let limited: Response | undefined;
    for (let i = 0; i < 250; i++) {
      const resp = await adminRequest(SELF, u, 'invite', admin.access_token, {
        method: 'POST', body: { emails: [] },
      });
      if (resp.status === 429) { limited = resp; break; }
      expect(resp.status).toBe(200);
    }
    expect(limited).toBeDefined();
    expect((await limited!.json() as any).error).toBe('rate_limited');
  });
});

describe('the table is the sole registration (Phase 2 — every route in it)', () => {
  it('every entry declares a method — asserted over the exported table, so a new row inherits it', async () => {
    const { buildAuthRouteTable } = await import('../src/router');
    const { env } = await import('cloudflare:test');
    const table = buildAuthRouteTable(env as any);
    expect(table.length).toBeGreaterThan(0); // the assertion below is vacuous over an empty table
    for (const entry of table) {
      // The runner treats an absent method as ANY verb — silently permissive on every one of
      // these single-verb routes.
      expect(entry.method, entry.path).toBeDefined();
    }
  });

  it('a wrong verb answers 405 from the edge on routes that used to fall through', async () => {
    const u = uni();
    // logout / refresh-token / create-galaxy each pass every other criterion while accepting any
    // verb if their entry drops its method.
    expect((await SELF.fetch(new Request(url(u, 'logout'), { method: 'GET' }))).status).toBe(405);
    expect((await SELF.fetch(new Request(url(u, 'refresh-token'), { method: 'PUT' }))).status).toBe(405);
    expect((await SELF.fetch(new Request('http://localhost/auth/create-galaxy', { method: 'GET' }))).status).toBe(405);
  });

  it('a throwaway suffix on the SCOPE-LESS family also 404s (no enumeration survives beside the table)', async () => {
    expect((await SELF.fetch(new Request('http://localhost/auth/frob', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }))).status).toBe(404);
  });
});

describe('no request the edge is going to REFUSE reaches the singleton', () => {
  it('GET /auth/claim-universe answers 405 at the edge and the Registry is never entered', async () => {
    // Positive control FIRST: a request the edge admits does emit the entry marker — otherwise the
    // absence below is the marker being broken, not the singleton being protected.
    const admitted = await SELF.fetch(new Request('http://localhost/auth/discover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'entry-probe@example.com' }),
    }));
    expect(admitted.status).toBe(200);
    expect(sink.filter((e) => e.namespace === 'nebula-auth.Registry.fetch').length).toBeGreaterThan(0);

    const mark = sink.length;
    const refused = await SELF.fetch(new Request('http://localhost/auth/claim-universe', { method: 'GET' }));
    // An edge 405 and a DO 405 are identical to the caller — the sink is what distinguishes them.
    // Reds against the old forward-before-checking, which woke the singleton with a bare GET,
    // unauthenticated and unrate-limited (ADR-018: an anonymous path to the one DO is an outage).
    expect(refused.status).toBe(405);
    expect(sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.fetch')).toHaveLength(0);
  });

  it('a malformed scope on a FLOW route is refused by the parse and the Registry is never entered', async () => {
    const mark = sink.length;
    const resp = await SELF.fetch(new Request('http://localhost/auth/bad..name/email-magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    }));
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_instance');
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });
});

describe('each forward terminal preserves what its row is allowed to touch', () => {
  it('an OPEN row forwards RAW: an arbitrary header reaches the DO, and a malformed body gets the DO\'s own 400', async () => {
    // Header fidelity — reds against collapsing the terminals into one rebuild, which drops every
    // header but Content-Type while leaving every status-only assertion green.
    const mark = sink.length;
    const withHeader = await SELF.fetch(new Request('http://localhost/auth/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forward-fidelity-probe': '1' },
      body: JSON.stringify({ email: 'fidelity-probe@example.com' }),
    }));
    expect(withHeader.status).toBe(200);
    const entries = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.fetch');
    expect(entries).toHaveLength(1);
    expect(entries[0].data.headerNames).toContain('x-forward-fidelity-probe');

    // Body fidelity — a rebuild absorbs malformed JSON into `{}` at the edge, so the DO would
    // answer a field-level 400 instead of its own JSON guard's `invalid_request`.
    const malformed = await SELF.fetch(new Request('http://localhost/auth/claim-universe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json{',
    }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error).toBe('invalid_request');
  });

  it('a forwardWithClaims row delivers callerClaims: the deletion record names the acting principal', async () => {
    // The full ADR-016 record shape (all four elements, under impersonation) is asserted in
    // mint-narrower-token.test.ts § scope deletion records the acting principal; this limb pins
    // that the TERMINAL delivers the claims at all, on the plain (non-impersonated) path.
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const star = `${u}.app.tenant`;
    const starAdmin = await foundStarAndLogin(SELF, star, 'del-admin@example.com', admin.access_token);

    const mark = sink.length;
    const resp = await SELF.fetch(new Request('http://localhost/auth/delete-scope', {
      method: 'POST',
      headers: { Authorization: `Bearer ${starAdmin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: star }),
    }));
    expect(resp.status).toBe(200);
    const record = sink.slice(mark).find((e) =>
      e.namespace === 'nebula-auth.Registry.executeScopeDeletion' && e.message === 'Scope deleted');
    expect(record).toBeDefined();
    expect(record.data.actingToken.sub).toBe(starAdmin.parsed.sub);
    expect(record.data.actingToken.access).toEqual({ authScope: star, scopeAdmin: true });
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
    const u = uni();
    const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const mark = sink.length;
    let limited: Response | undefined;
    // 250, not 101 — the simulator's fixed 60s window can roll over mid-loop (see the sub-keyed twin).
    for (let i = 0; i < 250; i++) {
      const resp = await routeNebulaAuthRequest(new Request(url(u, 'logout'), {
        method: 'POST', headers: { 'CF-Connecting-IP': ip },
      }), env as any);
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
    const u = uni();
    for (let i = 0; i < 120; i++) {
      const resp = await SELF.fetch(new Request(url(u, 'logout'), { method: 'POST' }));
      expect(resp.status).toBe(200);
    }
  });
});

describe('a superuser passes every instance-scoped route', () => {
  it('a platform caller passes /auth/{u}/invite (the root branch, not a special arm)', async () => {
    const u = uni();
    await foundUniverse(SELF, u, 'admin@example.com'); // the scope must exist to invite into
    const platform = await platformLogin(SELF, BOOTSTRAP_EMAIL);
    expect(platform.parsed.access.authScope).toBe('nebula-platform'); // fixture guard

    const resp = await adminRequest(SELF, u, 'invite', platform.access_token, {
      method: 'POST', body: { emails: ['platform-invited@example.com'] },
    });
    expect(resp.status).toBe(200);
    // The mint route's platform limbs live in mint-narrower-token.test.ts ("a bootstrap superuser
    // CAN mint…" / "…PLATFORM-scoped subject"), which now run through this same pipeline.
  });
});
