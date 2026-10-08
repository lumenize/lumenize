/**
 * A link signs in once: its page's `POST` spends it once the sessions are recorded, whatever the
 * acceptance then answers, and a spent link is refused by the consume itself.
 *
 * The page hides Continue for a spent link, but a token from browser history or a forwarded mail can
 * be posted without the page, so each limb here posts straight to `/auth/magic-link`. The `/live`
 * scenarios replay the same links through rendered pages in fresh browser contexts.
 *
 * In-lane for the one limb no running system can reach — `recordSessions` failing — and for the
 * replays beside it, which share its fixture.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { routeNebulaAuthRequest } from '../src/router';
import { GALAXY_CAP_MESSAGE, MAX_GALAXIES_PER_OWNER, REGISTRY_INSTANCE_NAME, SIGNUP_TICKET_COOKIE } from '../src/types';
import { recordingHooks } from './test-worker-and-dos';
import {
  claimUniverse, consumeLink, consumeRequest, cookieValue, foundUniverse, lookupLink, refreshCookiesSet,
  requestMagicLink, verifiedClaims,
} from './test-helpers';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `spend-${crypto.randomUUID().slice(0, 8)}@example.com`;
const registry = (): any => (env as any).AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
const USED = { error: 'link_used', error_description: 'This link was already used. Sign in again for a new one.' };

async function loginLink(email: string): Promise<string> {
  return (await (await requestMagicLink(SELF, email)).json() as { magicLinkUrl: string }).magicLinkUrl;
}

describe('a link signs in once', () => {
  it('a login link\'s replay is refused with the used-link message, sets no cookie, and its lookup says spent', async () => {
    const email = addr();
    await foundUniverse(SELF, uni(), email);
    const link = await loginLink(email);
    expect((await (await lookupLink(SELF, link)).json() as { spent: boolean }).spent).toBe(false);

    expect((await consumeLink(SELF, link)).status).toBe(200);
    const replay = await consumeLink(SELF, link);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual(USED);
    expect(replay.headers.getSetCookie()).toEqual([]);
    expect((await (await lookupLink(SELF, link)).json() as { spent: boolean }).spent).toBe(true);
  });

  it('a link for an address with no memberships is spent with its ticket: the replay gets no new one', async () => {
    const link = await loginLink(addr());
    const first = await consumeLink(SELF, link);
    expect(cookieValue(first, SIGNUP_TICKET_COOKIE)).toBeDefined();
    const replay = await consumeLink(SELF, link);
    expect(replay.status).toBe(409);
    expect(cookieValue(replay, SIGNUP_TICKET_COOKIE)).toBeUndefined();
  });

  it('an Accept the cap refused still spends the link, so its replay signs nobody in', async () => {
    const email = addr();
    const u = uni();
    const founder = await foundUniverse(SELF, u, email, 'crm');
    const claims = await verifiedClaims(founder.access_token);
    for (let i = 1; i < MAX_GALAXIES_PER_OWNER; i++) await registry().createGalaxy(`${u}.g${i}`, claims);

    const over = await claimUniverse(SELF, uni(), email, 'one-more');
    const refused = await consumeLink(SELF, over);
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error_description: string }).error_description).toBe(GALAXY_CAP_MESSAGE);
    // It proved the mailbox and set the cookies a consume sets, the accepted membership's included.
    expect(refreshCookiesSet(refused).has(u)).toBe(true);

    const replay = await consumeLink(SELF, over);
    expect(replay.status).toBe(409);
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  it('a consume that fails before its sessions are recorded leaves the link live for a retry', async () => {
    const email = addr();
    await foundUniverse(SELF, uni(), email);
    const link = await loginLink(email);

    // The Registry stub with `recordSessions` failing — the only way to make it fail, since no
    // running system does. Every other method is forwarded as a call: a stub's method is an RPC
    // proxy, so `.bind` on it would itself be sent as a method named `bind`.
    const real = (env as any).AUTH_REGISTRY;
    const reached: string[] = [];
    const failing = {
      getByName: (name: string) => {
        const stub = real.getByName(name);
        return new Proxy({}, {
          get(_t, prop: string) {
            return async (...args: unknown[]) => {
              reached.push(prop);
              if (prop === 'recordSessions') throw new Error('index write failed');
              return stub[prop](...args);
            };
          },
        });
      },
    };
    const failed = await routeNebulaAuthRequest(consumeRequest(link),
      { ...(env as any), AUTH_REGISTRY: failing } as Env, { hooks: recordingHooks });
    // Positive control: the failing consume got as far as the write that fails, past the consume.
    expect(reached).toEqual(['consumeLink', 'recordSessions']);
    expect(failed!.status).toBe(500);
    expect(failed!.headers.getSetCookie()).toEqual([]);

    const retry = await consumeLink(SELF, link);
    expect(retry.status).toBe(200);
    expect(refreshCookiesSet(retry).size).toBeGreaterThan(0);
  });

  it('the spend is recorded on the row, so a reader can tell a used link from an unused one', async () => {
    const email = addr();
    await foundUniverse(SELF, uni(), email);
    const link = await loginLink(email);
    await consumeLink(SELF, link);
    const spent = await (runInDurableObject as any)(registry(), (_i: any, c: any) =>
      [...c.storage.sql.exec("SELECT spentAt FROM MagicLinks WHERE email = ? AND purpose = 'login' AND spentAt IS NOT NULL", email)]);
    expect(spent).toHaveLength(1);
  });
});
