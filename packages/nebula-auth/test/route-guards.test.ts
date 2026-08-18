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
  foundUniverse, foundStarAndLogin, inviteAndLogin, adminRequest, url, platformLogin,
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

  it('same for /auth/bad..name/mint-narrower-token', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const mark = sink.length;
    const resp = await adminRequest(SELF, 'bad..name', 'mint-narrower-token', admin.access_token, {
      method: 'POST', body: { subOfNarrowerToken: 'x', activeScope: u },
    });
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toBe('invalid_instance');
    expect(registryEntriesSince(mark)).toHaveLength(0);
  });
});

describe('the mint refuses a non-admin BEFORE the registry read', () => {
  it('a member is refused forbidden and getIdentityScope never runs', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    const other = await inviteAndLogin(SELF, scope, admin.access_token, 'other@example.com');

    const mark = sink.length;
    const resp = await adminRequest(SELF, scope, 'mint-narrower-token', member.access_token, {
      method: 'POST', body: { subOfNarrowerToken: other.parsed.sub, activeScope: scope },
    });
    expect(resp.status).toBe(403);
    expect((await resp.json() as any).error).toBe('forbidden');
    // A 403 looks identical whether the refusal ran before or after the subject lookup — the
    // sink marker on `getIdentityScope` is what distinguishes them (no `sub`-existence probing).
    const lookups = sink.slice(mark).filter((e) => e.namespace === 'nebula-auth.Registry.getIdentityScope');
    expect(lookups).toHaveLength(0);
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

    const minted = await adminRequest(SELF, u, 'mint-narrower-token', admin.access_token, {
      method: 'POST', body: { subOfNarrowerToken: starAdmin.parsed.sub, activeScope: star },
    });
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
    let limited: Response | undefined;
    for (let i = 0; i < 120; i++) {
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
