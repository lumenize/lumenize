/**
 * A persona's invite is accepted from the mail it arrived in (`acceptPersonaInvite`).
 *
 * A persona is a member of an environment Star with nobody behind its address, so the Worker's mail
 * handler presses its Accept. Everything in a message is a stranger's to write, so the tests here
 * are mostly about what the handler will not act on: a login link, an invite into another scope, a
 * link issued to another address, an address that is no persona's.
 *
 * In-lane because each case is a membership's or a link's state this lane sets directly, and the
 * assertions read the Registry's own rows. What only mail can show, a real message routed to the
 * Worker's `email` handler, is the `/live` scenario `persona-host`. ADR-009 rung 2: the invite is
 * issued by the real Registry and its link comes back in test mode.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { acceptPersonaInvite } from '../../src/auth/worker-token';
import { personaAddress } from '../../src/auth/hosts';
import { rawRpcStub } from '../../src/raw-rpc';
import { recordingHooks } from './test-worker-and-dos';
import {
  authUrl, foundUniverse, issueInvitesAs, lookupLink, refreshAndParse, refreshCookie, registryStub,
  requestMagicLink, scopeOrigin,
} from './test-helpers';

const MAIL_DOMAIN = 'personas.example';

async function cast(names?: { universe: string; app: string }) {
  const u = names?.universe ?? `u${crypto.randomUUID().slice(0, 8)}`;
  const app = names?.app ?? 'first';
  const galaxy = `${u}.${app}`;
  const dev = `${galaxy}.dev`;
  const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`, app);
  const at = async (scope: string) => (await refreshAndParse(SELF, u, admin.refreshToken, scope)).access_token as string;
  const address = (slug: string) => `${slug}--dev.${app}.${u}@${MAIL_DOMAIN}`;
  /** Invite `email` into `scope` as the admin on that scope's page, and answer the mint. */
  const invite = async (email: string, scope = dev) => {
    const mint = await issueInvitesAs(await at(scope), scope, [{ email }]);
    expect(mint.errors).toEqual([]);
    return { link: mint.results[0]!.inviteUrl, sub: mint.results[0]!.sub };
  };
  const mail = (to: string, link: string | null) => acceptPersonaInvite(env as never, recordingHooks, { to, link });
  /** Whether Gerry's host opens for the admin: the persisted effect of an acceptance. */
  const opens = async (slug: string) => (await SELF.fetch(new Request(authUrl('refresh-token'), {
    method: 'POST',
    headers: { Origin: scopeOrigin(dev).replace('//dev.', `//${slug}--dev.`), Cookie: refreshCookie(u, admin.refreshToken) },
  }))).status === 200;
  const spent = async (link: string) => (await (await lookupLink(SELF, link)).json() as { spent: boolean }).spent;
  return { u, galaxy, dev, address, invite, mail, opens, spent };
}

/** How many sessions the Registry holds for `sub`. */
function sessionsOf(sub: string): Promise<number> {
  return (runInDurableObject as any)(registryStub(), (_i: unknown, c: any) =>
    [...c.storage.sql.exec('SELECT tokenHash FROM RefreshTokenIndex WHERE sub = ?', sub)].length);
}

/** Whether the Registry holds `email`'s mailbox as proved, as it does for a person who followed a link. */
function mailboxProved(email: string): Promise<boolean> {
  return (runInDurableObject as any)(registryStub(), (_i: unknown, c: any) =>
    [...c.storage.sql.exec('SELECT emailVerified FROM Emails WHERE email = ?', email)][0]?.emailVerified === 1);
}

describe("a persona's invite is accepted from its mail", () => {
  it('accepts an invite into the Star the address spells, names the persona, and records no session', async () => {
    const c = await cast();
    const gerry = await c.invite(c.address('gerry'));
    expect(await c.opens('gerry')).toBe(false); // pending: the control the acceptance must move
    expect(await mailboxProved(c.address('gerry'))).toBe(false);
    expect(await c.mail(c.address('gerry'), gerry.link)).toEqual({ outcome: 'accepted', scope: c.dev, sub: gerry.sub });
    // Counted before any page opens: the acceptance places no session, since no browser took the
    // link. The first refresh from the persona's host opens one, which the next line's does.
    expect(await sessionsOf(gerry.sub)).toBe(0);
    expect(await c.opens('gerry')).toBe(true);
    expect(await sessionsOf(gerry.sub)).toBe(1);
    expect(await c.spent(gerry.link)).toBe(true);
    // The message arrived at the address, which proves the mailbox as a followed link does.
    expect(await mailboxProved(c.address('gerry'))).toBe(true);
    const identity = await registryStub().getIdentityScope(gerry.sub) as { profileId: string };
    expect(await rawRpcStub('PROFILE', identity.profileId).readDisplayNames()).toEqual({ nickname: 'gerry' });
  });

  // Two long slugs put the host's labels past the 64 characters a mailbox name may hold.
  it('accepts a persona of an app with long names at its short address, and opens its host', async () => {
    const u = `u${crypto.randomUUID().replace(/-/g, '').slice(0, 29)}`;
    const c = await cast({ universe: u, app: `a${'p'.repeat(29)}` });
    const short = await personaAddress({ persona: 'gerry', scope: c.dev }, MAIL_DOMAIN);
    expect(short).toMatch(/^gerry--dev\.[0-9a-f]{16}@personas\.example$/);
    const gerry = await c.invite(short);
    expect((await c.mail(short, gerry.link)).outcome).toBe('accepted');
    expect(await c.opens('gerry')).toBe(true);
    // The labels themselves are no address of Gerry's here, though they are shaped as one.
    const labels = await c.invite(c.address('gerry'));
    expect(await c.mail(c.address('gerry'), labels.link))
      .toEqual({ outcome: 'dropped', reason: "the link is no invite into this persona's Star" });
  });

  it('reads the address whatever its case', async () => {
    const c = await cast();
    const gerry = await c.invite(c.address('gerry'));
    expect((await c.mail(c.address('gerry').toUpperCase(), gerry.link)).outcome).toBe('accepted');
  });

  it('changes nothing when the same message arrives twice', async () => {
    const c = await cast();
    const gerry = await c.invite(c.address('gerry'));
    await c.mail(c.address('gerry'), gerry.link);
    expect(await c.mail(c.address('gerry'), gerry.link)).toEqual({ outcome: 'dropped', reason: 'the link was already used' });
    expect(await sessionsOf(gerry.sub)).toBe(0); // before the page below opens its own
    expect(await c.opens('gerry')).toBe(true);
  });

  it('drops a login link, leaves it unspent, and accepts nothing by it', async () => {
    const c = await cast();
    await c.invite(c.address('gerry')); // a pending invite the login link must not take up
    const resp = await requestMagicLink(SELF, c.address('gerry'));
    const { magicLinkUrl } = await resp.json() as { magicLinkUrl: string };
    expect(await c.mail(c.address('gerry'), magicLinkUrl))
      .toEqual({ outcome: 'dropped', reason: "the link is no invite into this persona's Star" });
    expect(await c.spent(magicLinkUrl)).toBe(false);
    expect(await c.opens('gerry')).toBe(false);
  });

  it("drops an invite into the app, though it mints a pending membership at the persona's own Star", async () => {
    const c = await cast();
    const intoApp = await c.invite(c.address('gerry'), c.galaxy);
    expect(await c.mail(c.address('gerry'), intoApp.link))
      .toEqual({ outcome: 'dropped', reason: "the link is no invite into this persona's Star" });
    expect(await c.spent(intoApp.link)).toBe(false);
    expect(await c.opens('gerry')).toBe(false);
  });

  it('drops a link issued to another address, and accepts neither', async () => {
    const c = await cast();
    const sally = await c.invite(c.address('sally'));
    await c.invite(c.address('gerry'));
    expect(await c.mail(c.address('gerry'), sally.link))
      .toEqual({ outcome: 'dropped', reason: 'the link was issued to another address' });
    expect(await c.spent(sally.link)).toBe(false);
    expect(await c.opens('sally')).toBe(false);
    expect(await c.opens('gerry')).toBe(false);
  });

  it.each([
    ['no link', null, 'the message carries no link'],
    ['a link that is no URL', 'click here', 'the message carries no link'],
    ['a URL with no token', 'https://platform.lumenize.localhost/auth/magic-link', 'the message carries no link'],
    ['a token nobody issued', 'https://platform.lumenize.localhost/auth/magic-link?token=nope', 'the link is unknown or has expired'],
  ])('drops a message to a persona carrying %s', async (_name, link, reason) => {
    const c = await cast();
    await c.invite(c.address('gerry'));
    expect(await c.mail(c.address('gerry'), link)).toEqual({ outcome: 'dropped', reason });
    expect(await c.opens('gerry')).toBe(false);
  });

  it('answers that an address is no persona, and accepts nothing for it', async () => {
    const c = await cast();
    const person = `pat-${c.u}@${MAIL_DOMAIN}`;
    const pat = await c.invite(person);
    expect(await c.mail(person, pat.link)).toEqual({ outcome: 'not-a-persona' });
    expect(await c.spent(pat.link)).toBe(false);
    // A persona's labels at another domain are no persona either.
    const gerry = await c.invite(c.address('gerry'));
    expect(await c.mail(c.address('gerry').replace(MAIL_DOMAIN, 'example.com'), gerry.link)).toEqual({ outcome: 'not-a-persona' });
    expect(await c.opens('gerry')).toBe(false);
  });
});
