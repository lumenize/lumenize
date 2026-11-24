/**
 * A claim writes an account and its first app; acceptance says what it did; and the refresh record
 * the Worker writes is reaped when the Registry no longer stands behind it.
 *
 * Grounding: rung 2 (test-mode issuance) through the real Worker → Registry → KV paths.
 *
 * Why these run here rather than in `/live`, case by case (`live.md` § *`/live` is the DEFAULT tier*):
 * - **The three rows and the slug refusals** read `Scopes` directly, which no running system shows
 *   before anyone accepts; `/live` covers the same claims through their records.
 * - **Acceptance's outcomes** are a value passed from the Registry to the Worker, which nothing
 *   observes until the certificate marker exists.
 * - **The stranger and superuser counts** each need twenty or more claims whose only job is to fill
 *   the count; in `/live` every one would be a real letter no assertion reads.
 * - **The reap** needs a revoke timed between the Registry's answer and the Worker's put, which no
 *   running system can arrange. Each limb wraps the Worker's KV binding so the revoke's effect, the
 *   index row gone or the bit flipped, lands just before the put; and the race inside a revoke's own
 *   KV delete is played through the Registry's `registryKvHook`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { routeAuthRequest } from '../../src/auth/router';
import { GALAXY_CAP_MESSAGE, MAX_GALAXIES_PER_OWNER, REGISTRY_INSTANCE_NAME } from '../../src/auth/types';
import type { AcceptanceOutcome } from '../../src/auth/types';
import { recordingHooks, recordedTeardowns, recordedOrders, orderHook, registryKvHook } from './test-worker-and-dos';
import { wakeCertificates } from '../../src/auth/worker-token';
import {
  claimUniverse, clickLink, foundUniverse, refreshAndParse, authUrl, signupClaim, proveNewAddress,
  verifiedClaims, platformLogin, acceptMembership, plainLogin, consumeLink, consumeRequest,
  refreshCookie, refreshCookiesSet, scopeOrigin, requestMagicLink, BOOTSTRAP_EMAIL,
} from './test-helpers';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `claim-${crypto.randomUUID().slice(0, 8)}@example.com`;
const registry = (): any => (env as any).AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
const kv = (): KVNamespace => (env as any).REFRESH_TOKEN_KV;

/** Which of `scopes` have a `Scopes` row. */
async function scopeRows(scopes: string[]): Promise<string[]> {
  return (runInDurableObject as any)(registry(), (_i: any, c: any) => scopes.filter((s) =>
    [...c.storage.sql.exec('SELECT 1 FROM Scopes WHERE universeGalaxyStarId = ?', s)].length > 0));
}

/** The membership `email` holds at `scope`: its `sub` and whether it was accepted, or `null`. */
async function membershipAt(email: string, scope: string): Promise<{ sub: string; accepted: boolean; scopeAdmin: boolean } | null> {
  const rows = await (runInDurableObject as any)(registry(), (_i: any, c: any) => [...c.storage.sql.exec(
    `SELECT m.sub AS sub, m.acceptedAt AS acceptedAt, m.scopeAdmin AS scopeAdmin
     FROM Memberships m JOIN Emails e ON e.emailId = m.emailId WHERE e.email = ? AND m.universeGalaxyStarId = ?`,
    email, scope)]);
  return rows.length === 0 ? null
    : { sub: rows[0].sub, accepted: rows[0].acceptedAt != null, scopeAdmin: Boolean(rows[0].scopeAdmin) };
}

/** POST `claim-universe` with whatever body a case names. */
function postClaim(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(new Request(authUrl('claim-universe'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

/** Accept through the Registry by direct RPC, as the Worker does, returning the outcome value. */
function accept(sub: string): Promise<AcceptanceOutcome> {
  return registry().acceptMembership(sub, { credential: 'refresh-cookie', operationId: crypto.randomUUID() });
}

describe('a claim writes the account and its first app', () => {
  it('a claim for acme and crm writes three scopes and one unaccepted admin membership at acme', async () => {
    const u = uni();
    const email = addr();
    await claimUniverse(SELF, u, email, 'crm');
    expect(await scopeRows([u, `${u}.crm`, `${u}.crm.dev`])).toEqual([u, `${u}.crm`, `${u}.crm.dev`]);
    expect(await membershipAt(email, u)).toMatchObject({ accepted: false, scopeAdmin: true });
    // The first app needs no membership of its own: the universe membership's dominion covers it.
    expect(await membershipAt(email, `${u}.crm`)).toBeNull();
    expect(await membershipAt(email, `${u}.crm.dev`)).toBeNull();
  });

  // A 31-character slug, a `--` and an uppercase letter, at both claim paths. Each is refused by
  // its message and leaves no row; `crm` is the positive control.
  const BAD_APP_SLUGS = ['a'.repeat(31), 'two--dashes', 'Bad_Slug'];

  it('the direct claim refuses a bad first app slug by message, and writes nothing', async () => {
    for (const appSlug of BAD_APP_SLUGS) {
      const u = uni();
      const resp = await postClaim({ slug: u, appSlug, email: addr() });
      expect(resp.status, appSlug).toBe(400);
      expect(await resp.json(), appSlug).toEqual({ error: 'invalid_app_slug', error_description: 'Invalid app slug format' });
      expect(await scopeRows([u, `${u}.${appSlug}`]), appSlug).toEqual([]);
    }
    const u = uni();
    expect((await postClaim({ slug: u, appSlug: 'crm', email: addr() })).status).toBe(200);
    expect(await scopeRows([`${u}.crm`])).toEqual([`${u}.crm`]);
  });

  it('the ticket claim refuses a bad first app slug by message, and writes nothing', async () => {
    for (const appSlug of BAD_APP_SLUGS) {
      const { ticket } = await proveNewAddress(SELF, addr());
      const u = uni();
      const resp = await signupClaim(SELF, { slug: u, appSlug }, ticket);
      expect(resp.status, appSlug).toBe(400);
      expect(await resp.json(), appSlug).toEqual({ error: 'invalid_app_slug', error_description: 'Invalid app slug format' });
      expect(await scopeRows([u, `${u}.${appSlug}`]), appSlug).toEqual([]);
    }
    const { ticket } = await proveNewAddress(SELF, addr());
    const u = uni();
    expect((await signupClaim(SELF, { slug: u, appSlug: 'crm' }, ticket)).status).toBe(200);
    expect(await scopeRows([u, `${u}.crm`, `${u}.crm.dev`])).toEqual([u, `${u}.crm`, `${u}.crm.dev`]);
  });
});

describe('acceptance tells its outcomes apart', () => {
  it('a first Accept answers accepted, naming what to tear down and the galaxy; a second, already accepted', async () => {
    const u = uni();
    const email = addr();
    await claimUniverse(SELF, u, email, 'crm');
    await plainLogin(SELF, email); // a session to re-put, placed without accepting
    const { sub } = (await membershipAt(email, u))!;

    const first = await accept(sub);
    expect(first.outcome).toBe('accepted');
    if (first.outcome !== 'accepted') return;
    expect(first.scope).toBe(u);
    expect(first.accepted).toEqual([sub]);
    expect(first.galaxies).toEqual([`${u}.crm`]);
    expect([...first.teardown].sort((a, b) => a.instanceName.localeCompare(b.instanceName))).toEqual([
      { instanceName: u, tier: 'universe' },
      { instanceName: `${u}.crm`, tier: 'galaxy' },
      { instanceName: `${u}.crm.dev`, tier: 'star' },
    ]);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0].record).toMatchObject({ sub, universeGalaxyStarId: u, accepted: true });

    expect(await accept(sub)).toEqual({ outcome: 'already-accepted', scope: u, galaxies: [`${u}.crm`] });
  });

  it('a later Accept names the live galaxies, never one a deletion removed', async () => {
    const u = uni();
    const email = addr();
    const founder = await foundUniverse(SELF, u, email, 'crm');
    const claims = await verifiedClaims(founder.access_token);
    await registry().createGalaxy(`${u}.web`, claims);
    await registry().executeScopeDeletion(`${u}.crm`, claims);
    const { sub } = (await membershipAt(email, u))!;
    expect(await accept(sub)).toEqual({ outcome: 'already-accepted', scope: u, galaxies: [`${u}.web`] });
  });

  it('an Accept past the cap is refused as a value, and the membership stays unaccepted', async () => {
    const email = addr();
    const u = uni();
    const founder = await foundUniverse(SELF, u, email, 'crm'); // one galaxy
    const claims = await verifiedClaims(founder.access_token);
    for (let i = 1; i < MAX_GALAXIES_PER_OWNER; i++) await registry().createGalaxy(`${u}.g${i}`, claims);

    const second = uni();
    await claimUniverse(SELF, second, email, 'one-more');
    const { sub } = (await membershipAt(email, second))!;
    expect(await accept(sub)).toEqual({ outcome: 'refused', reason: 'galaxy_cap', message: GALAXY_CAP_MESSAGE });
    expect((await membershipAt(email, second))!.accepted).toBe(false);
  });

  it('an Accept for a membership a deletion removed answers no such membership', async () => {
    const u = uni();
    const email = addr();
    const founder = await foundUniverse(SELF, u, email);
    const { sub } = (await membershipAt(email, u))!;
    await registry().executeScopeDeletion(u, await verifiedClaims(founder.access_token));
    expect(await accept(sub)).toEqual({ outcome: 'not-found' });
  });

  // Both acceptance writers reach the one helper, so each wipes on a first Accept and neither on a
  // second: the link page's `POST`, then Home's `accept-membership` on a membership a plain login
  // placed.
  it('the Worker wipes the claim\'s scopes on its first Accept only, through either writer', async () => {
    const viaLink = uni();
    const linkEmail = addr();
    const link = await claimUniverse(SELF, viaLink, linkEmail, 'crm');
    recordedTeardowns.length = 0;
    const { refreshToken } = await clickLink(SELF, link);
    expect(recordedTeardowns).toHaveLength(1);
    expect(recordedTeardowns[0].cause).toBe('creation');
    expect(recordedTeardowns[0].targets.map((t) => t.instanceName).sort())
      .toEqual([viaLink, `${viaLink}.crm`, `${viaLink}.crm.dev`]);
    await acceptMembership(SELF, viaLink, refreshToken);
    expect(recordedTeardowns).toHaveLength(1);

    const viaHome = uni();
    const homeEmail = addr();
    await claimUniverse(SELF, viaHome, homeEmail, 'crm');
    const { tokenFor } = await plainLogin(SELF, homeEmail);
    recordedTeardowns.length = 0;
    await acceptMembership(SELF, viaHome, tokenFor(viaHome));
    expect(recordedTeardowns.map((t) => t.targets.map((x) => x.instanceName).sort()))
      .toEqual([[viaHome, `${viaHome}.crm`, `${viaHome}.crm.dev`]]);
    await acceptMembership(SELF, viaHome, tokenFor(viaHome));
    expect(recordedTeardowns).toHaveLength(1);
  });
});

describe('the cap counts what the address has accepted, less the root', () => {
  it('a stranger\'s claims naming your address cannot fill your count', async () => {
    const victim = addr();
    for (let i = 0; i < MAX_GALAXIES_PER_OWNER; i++) await claimUniverse(SELF, uni(), victim);
    const own = uni();
    const resp = await consumeLink(SELF, await claimUniverse(SELF, own, victim, 'mine'));
    expect(resp.status, JSON.stringify(await resp.clone().json())).toBe(200);
    expect((await membershipAt(victim, own))!.accepted).toBe(true);
  });

  it('a superuser\'s root membership counts none of the zone\'s galaxies', async () => {
    // More galaxies than the cap exist elsewhere on the zone, claimed by strangers.
    for (let i = 0; i <= MAX_GALAXIES_PER_OWNER; i++) await claimUniverse(SELF, uni(), addr());
    await platformLogin(SELF); // the bootstrap address, accepted at the root
    const own = uni();
    const founder = await foundUniverse(SELF, own, BOOTSTRAP_EMAIL);
    await registry().createGalaxy(`${own}.second`, await verifiedClaims(founder.access_token));
    expect(await scopeRows([`${own}.second`])).toEqual([`${own}.second`]);
  });
});

describe('a superseded claim leaves nothing behind', () => {
  const entries: any[] = [];
  beforeEach(() => { entries.length = 0; setDebugSink((e) => entries.push(e)); });
  afterEach(() => clearDebugSink());

  it('the retired claim\'s whole subtree goes, the record names it, and the slug can be claimed again', async () => {
    const email = addr();
    const retired = uni();
    const kept = uni();
    await claimUniverse(SELF, retired, email, 'crm');
    await clickLink(SELF, await claimUniverse(SELF, kept, email, 'crm')); // the claim page's Accept

    expect(await scopeRows([retired, `${retired}.crm`, `${retired}.crm.dev`])).toEqual([]);
    const record = entries.find((e) => e.namespace === 'nebula-auth.Registry.claim.converged');
    expect(record?.data.retired).toEqual([retired, `${retired}.crm`, `${retired}.crm.dev`]);
    expect((await postClaim({ slug: retired, appSlug: 'crm', email: addr() })).status).toBe(200);
  });
});

describe('a refresh record put after its row changed is reaped', () => {
  const entries: any[] = [];
  beforeEach(() => { entries.length = 0; setDebugSink((e) => entries.push(e)); });
  afterEach(() => clearDebugSink());
  const reaped = () => entries.filter((e) => e.message === 'orphan-reaped');

  /**
   * The refresh KV with `before` run ahead of a put — the revoke or flip timed into the gap. `fromPut`
   * skips the puts ahead of it, so a request that puts twice, a consume and then its acceptance's
   * re-put, can be hooked at the second alone.
   */
  function kvWithPutHook(before: (tokenHash: string, record: any) => Promise<void>, fromPut = 1): KVNamespace {
    const target = kv();
    let puts = 0;
    return new Proxy(target, {
      get(t, prop) {
        if (prop === 'put') {
          return async (key: string, value: string, opts?: KVNamespacePutOptions) => {
            if (++puts >= fromPut) await before(key.slice('refresh:'.length), JSON.parse(value));
            return t.put(key, value, opts);
          };
        }
        const v = (t as any)[prop];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as KVNamespace;
  }
  const dropIndexRow = async (tokenHash: string) => {
    await (runInDurableObject as any)(registry(), (_i: any, c: any) =>
      c.storage.sql.exec('DELETE FROM RefreshTokenIndex WHERE tokenHash = ?', tokenHash));
  };
  const flipScopeAdmin = async (_tokenHash: string, record: any) => {
    await (runInDurableObject as any)(registry(), (_i: any, c: any) =>
      c.storage.sql.exec('UPDATE Memberships SET scopeAdmin = ? WHERE sub = ?', record.scopeAdmin ? 0 : 1, record.sub));
  };
  const hooked = (before: (h: string, r: any) => Promise<void>, fromPut = 1) =>
    ({ ...(env as any), REFRESH_TOKEN_KV: kvWithPutHook(before, fromPut) }) as Env;
  const routeWith = (request: Request, e: Env) => routeAuthRequest(request, e, { hooks: recordingHooks });
  const cookieOf = (resp: Response, scope: string): string => {
    const token = refreshCookiesSet(resp).get(scope);
    if (!token) throw new Error(`no cookie for ${scope}`);
    return token;
  };
  /** A plain login link for `email`, which places cookies and accepts nothing. */
  const loginLink = async (email: string): Promise<string> =>
    ((await (await requestMagicLink(SELF, email)).json()) as { magicLinkUrl: string }).magicLinkUrl;
  const kvHas = async (refreshToken: string) => (await kv().get(`refresh:${await hashString(refreshToken)}`)) !== null;

  for (const [label, before] of [['its index row deleted', dropIndexRow], ['its scopeAdmin flipped', flipScopeAdmin]] as const) {
    // A plain login's consume, so the request puts once and accepts nothing.
    it(`the consume's put, with ${label} in the gap, leaves no record`, async () => {
      const u = uni();
      const email = addr();
      await claimUniverse(SELF, u, email);
      const resp = await routeWith(consumeRequest(await loginLink(email)), hooked(before));
      expect(await kvHas(cookieOf(resp!, u))).toBe(false);
      expect(reaped().map((e) => e.data.sub)).toEqual([(await membershipAt(email, u))!.sub]);
    });

    // The two acceptance writers, each hooked at the acceptance's own re-put: Home's, on a session a
    // plain login placed, and the link page's, whose consume puts first.
    it(`Home acceptance's re-put, with ${label} in the gap, leaves no record`, async () => {
      const u = uni();
      const email = addr();
      await claimUniverse(SELF, u, email);
      const { tokenFor } = await plainLogin(SELF, email);
      const resp = await routeWith(new Request(authUrl('accept-membership'), {
        method: 'POST', headers: { Cookie: refreshCookie(u, tokenFor(u)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: u }),
      }), hooked(before));
      expect(resp!.status).toBe(200);
      expect(await kvHas(tokenFor(u))).toBe(false);
      expect(reaped()).toHaveLength(1);
    });

    it(`the link page's acceptance re-put, with ${label} in the gap, leaves no record`, async () => {
      const u = uni();
      const resp = await routeWith(consumeRequest(await claimUniverse(SELF, u, addr())), hooked(before, 2));
      expect(resp!.status).toBe(200);
      expect(await kvHas(cookieOf(resp!, u))).toBe(false);
      expect(reaped()).toHaveLength(1);
    });

    it(`the refresh fallback's healed copy, with ${label} in the gap, leaves no record`, async () => {
      const u = uni();
      const { refreshToken } = await foundUniverse(SELF, u, addr());
      await kv().delete(`refresh:${await hashString(refreshToken)}`); // the miss the fallback heals
      await routeWith(new Request(authUrl('refresh-token'), {
        method: 'POST', headers: { Origin: scopeOrigin(u), Cookie: refreshCookie(u, refreshToken) },
      }), hooked(before));
      expect(await kvHas(refreshToken)).toBe(false);
      expect(reaped()).toHaveLength(1);
    });
  }

  it('setIdentityAdmin\'s re-put, with its index row deleted in flight, leaves no record', async () => {
    const u = uni();
    const founder = await foundUniverse(SELF, u, addr());
    const claims = await verifiedClaims(founder.access_token);
    await (runInDurableObject as any)(registry(), async (instance: any, c: any) => {
      const original = instance.env;
      instance.env = {
        ...original,
        REFRESH_TOKEN_KV: kvWithPutHook(async (tokenHash) => {
          c.storage.sql.exec('DELETE FROM RefreshTokenIndex WHERE tokenHash = ?', tokenHash);
        }),
      };
      try { await instance.setIdentityAdmin(founder.parsed.sub, false, claims); }
      finally { instance.env = original; }
    });
    expect(await kvHas(founder.refreshToken)).toBe(false);
    expect(reaped()).toHaveLength(1);
  });

  it('with the row unchanged, the record stays and the next refresh mints', async () => {
    const u = uni();
    const link = await claimUniverse(SELF, u, addr());
    const resp = await routeWith(consumeRequest(link), hooked(async () => {}));
    const refreshToken = cookieOf(resp!, u);
    expect(await kvHas(refreshToken)).toBe(true);
    expect((await refreshAndParse(SELF, u, refreshToken)).parsed.sub).toBeDefined();
    expect(reaped()).toEqual([]);
  });
});

describe("the Registry's own check follows the host rule", () => {
  // In-lane, since no running system reaches the Registry but through the facade, which refuses
  // first. A universe admin's claims from a tenant's page hold no dominion over the galaxy or the
  // universe above that page, so the Registry refuses them on its own, whoever skipped the facade.
  it("refuses a universe admin's claims from a tenant's page, and admits the same membership from the universe's", async () => {
    const u = uni();
    const founder = await foundUniverse(SELF, u, addr(), 'crm');
    const fromTenant = await verifiedClaims((await refreshAndParse(SELF, u, founder.refreshToken, `${u}.crm.t1`)).access_token);
    expect(fromTenant.aud).toBe(`${u}.crm.t1`);
    expect(fromTenant.access.authScope).toBe(u); // the membership covers both targets
    // Awaited before matching, so an admission reads as `(admitted)` rather than as a matcher
    // tripping over a resolved RPC promise.
    const outcome = async (p: Promise<unknown>) => { try { await p; return '(admitted)'; } catch (e) { return (e as Error).message; } };
    expect(await outcome(registry().createGalaxy(`${u}.web`, fromTenant)))
      .toBe('Caller does not have admin access to the parent universe');
    expect(await outcome(registry().executeScopeDeletion(`${u}.crm`, fromTenant)))
      .toBe(`Caller is not an admin of "${u}.crm"`);
    // The positive control: the universe's own page holds both.
    const fromUniverse = await verifiedClaims(founder.access_token);
    expect(fromUniverse.aud).toBe(u);
    expect(await registry().createGalaxy(`${u}.web`, fromUniverse)).toEqual({ instanceName: `${u}.web` });
  });
});

describe('a revoke strands no record a concurrent writer put', () => {
  // The dangerous shape: a writer's put lands after the revoke's KV delete, and its check reads the
  // index before the revoke un-indexes, so the check keeps the put. The hook plays that writer inside
  // the revoke's own delete, which is the gap; a writer can only reach it by racing a real revoke.
  afterEach(() => { registryKvHook.afterDelete = undefined; });

  it('a put checked while the revoke awaits its delete is deleted all the same', async () => {
    const u = uni();
    const email = addr();
    await claimUniverse(SELF, u, email);
    const link = ((await (await requestMagicLink(SELF, email)).json()) as { magicLinkUrl: string }).magicLinkUrl;
    const cookie = refreshCookiesSet((await consumeLink(SELF, link))!).get(u)!;
    const key = `refresh:${await hashString(cookie)}`;
    const record = await kv().get(key);
    expect(record, 'the login must have put its record').not.toBeNull();

    let checkSaw: unknown = 'never ran';
    registryKvHook.afterDelete = async (deleted) => {
      if (deleted !== key || checkSaw !== 'never ran') return;
      await kv().put(key, record!);
      checkSaw = await registry().getRefreshRecord(key.slice('refresh:'.length));
    };
    const loggedOut = await SELF.fetch(authUrl('logout'), {
      method: 'POST', headers: { Cookie: refreshCookie(u, cookie), 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(loggedOut.status).toBeLessThan(400);
    await loggedOut.text();
    // The fixture is the dangerous shape: the writer's check found the row and kept its put.
    expect(checkSaw).not.toBeNull();
    expect(checkSaw).not.toBe('never ran');
    expect(await kv().get(key)).toBeNull();
  });
});

describe('a certificate wake a deletion overtakes is torn down again', () => {
  // In-lane, since no running system can time a deletion into the gap between the Registry's
  // answer and the wake: the recording wake deletes the galaxy's `Scopes` row when it is called.
  afterEach(() => { orderHook.onOrder = undefined; });
  const deleteRow = (scope: string) => (runInDurableObject as any)(registry(), (_i: any, c: any) => {
    c.storage.sql.exec('DELETE FROM Scopes WHERE universeGalaxyStarId = ?', scope);
  });
  const reapOf = (galaxy: string) => recordedTeardowns.find((t) => t.cause === 'deletion'
    && t.targets.some((x) => x.instanceName === galaxy));

  it("a claim's acceptance re-reads the galaxy it woke, and tears it down when the row is gone", async () => {
    const u = uni();
    orderHook.onOrder = (galaxy) => deleteRow(galaxy);
    await foundUniverse(SELF, u, addr(), 'crm');
    const order = recordedOrders.find((o) => o.galaxy === `${u}.crm`);
    expect(order, 'the acceptance must wake the claim galaxy').toBeDefined();
    const reap = reapOf(`${u}.crm`);
    expect(reap?.targets).toEqual([{ instanceName: `${u}.crm`, tier: 'galaxy' }, { instanceName: `${u}.crm.dev`, tier: 'star' }]);
    expect(reap?.operationId).toBe(order!.operationId);
  });

  it('with the row left standing, the wake tears nothing down', async () => {
    // The positive control: the same acceptance, nothing deleted in the gap.
    const u = uni();
    await foundUniverse(SELF, u, addr(), 'crm');
    expect(recordedOrders.some((o) => o.galaxy === `${u}.crm`)).toBe(true);
    expect(reapOf(`${u}.crm`)).toBeUndefined();
  });

  it('the shared helper, which the facade create calls too, reaps by the same re-read', async () => {
    const g = `${uni()}.web`;
    await wakeCertificates({ checkSlugAvailable: () => true }, recordingHooks, [g], 'op-gone');
    expect(reapOf(g)?.operationId).toBe('op-gone');
    const kept = `${uni()}.web`;
    await wakeCertificates({ checkSlugAvailable: () => false }, recordingHooks, [kept], 'op-kept');
    expect(reapOf(kept)).toBeUndefined();
  });

  it('a re-read that fails is logged and never rejects, since the create or acceptance has landed', async () => {
    const g = `${uni()}.web`;
    const logged: Array<{ namespace: string; level: string; data?: Record<string, unknown> }> = [];
    setDebugSink((e) => logged.push(e as never));
    try {
      await wakeCertificates({ checkSlugAvailable: () => { throw new Error('registry unreachable'); } }, recordingHooks, [g], 'op-flaky');
    } finally {
      clearDebugSink();
    }
    expect(recordedOrders.some((o) => o.galaxy === g)).toBe(true);
    expect(logged.find((e) => e.namespace === 'nebula-auth.certificate' && e.level === 'error')?.data)
      .toMatchObject({ galaxy: g, operationId: 'op-flaky' });
  });
});
