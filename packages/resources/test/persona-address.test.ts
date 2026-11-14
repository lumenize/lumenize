/**
 * `NebulaClient.personaAddress` spells a persona's address from the Star its page's token is for,
 * and refuses where there is no persona to spell one for.
 *
 * vitest-plugin rather than `/live` for the refusals: a served dev Star page always carries the
 * mail domain, so only a client built by hand can lack one, sit on a Star that holds no personas,
 * or be asked for a slug no cast could hold. `persona-tabs` drives the spelling on a real page.
 * The Client is a real `NebulaClient`, logged in through Mesh's Registry (ADR-009 rung 2).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/resources/client';
import { personaAddress } from '@lumenize/mesh/client';
import { PLATFORM } from '../../mesh/test/auth/test-helpers';
import { loginAt, uniqueScope, type Login } from '../../mesh/test/support/login';
import { ONTOLOGY_VERSION } from './test-worker';

const MAIL_DOMAIN = 'personas.example';

/** A connected `NebulaClient` on `login`'s page, with or without a persona mail domain. */
async function pageClient(login: Login, personaMailDomain?: string): Promise<NebulaClient> {
  const browser = new Browser();
  browser.setCookie(login.cookie.name, login.cookie.value, { domain: new URL(PLATFORM).hostname, path: '/' });
  const page = browser.context(login.baseUrl);
  const client = new NebulaClient({
    instanceName: `${login.sub}.tab1`, baseUrl: login.baseUrl, platformOrigin: PLATFORM,
    ontologyVersion: ONTOLOGY_VERSION, fetch: page.fetch, WebSocket: page.WebSocket,
    ...(personaMailDomain ? { personaMailDomain } : {}),
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

describe('client.personaAddress', () => {
  it('spells the address its host spells, on a dev Star\'s page', async () => {
    const u = uniqueScope('pa');
    const dev = `${u}.app.dev`;
    using client = await pageClient(await loginAt(u, { page: dev }), MAIL_DOMAIN);
    expect(client.activeScope).toBe(dev);
    expect(await client.personaAddress('gerry')).toBe(`gerry--dev.app.${u}@${MAIL_DOMAIN}`);
    // The same spelling the Worker's mail handler and the host's refresh check against.
    expect(await client.personaAddress('gerry')).toBe(await personaAddress({ persona: 'gerry', scope: dev }, MAIL_DOMAIN));
  });

  // Mutation: drop the slug check after spelling → a two-letter slug, which no host can carry,
  // comes back as an address the mail handler would then reject.
  it.each([
    ['two letters', 'ed'],
    ['an upper-case letter', 'Gerry'],
    ['a double hyphen', 'ger--ry'],
  ])('refuses a slug with %s, which no persona\'s host could carry', async (_why, slug) => {
    const u = uniqueScope('pa');
    using client = await pageClient(await loginAt(u, { page: `${u}.app.dev` }), MAIL_DOMAIN);
    await expect(client.personaAddress(slug)).rejects.toThrow(`personaAddress: "${slug}" on "${u}.app.dev" is no persona`);
  });

  // Mutation: let any Star's page spell one → a tenant Star's page answers an address no handler accepts.
  it('refuses on a Star that holds no personas, and on a page given no mail domain', async () => {
    const u = uniqueScope('pa');
    using tenant = await pageClient(await loginAt(u, { page: `${u}.app.tenant-a` }), MAIL_DOMAIN);
    await expect(tenant.personaAddress('gerry')).rejects.toThrow(`personaAddress: "gerry" on "${u}.app.tenant-a" is no persona`);
    const u2 = uniqueScope('pa');
    using bare = await pageClient(await loginAt(u2, { page: `${u2}.app.dev` }));
    await expect(bare.personaAddress('gerry')).rejects.toThrow('only a dev Star\'s own page has personas, and this page is not one');
  });
});
