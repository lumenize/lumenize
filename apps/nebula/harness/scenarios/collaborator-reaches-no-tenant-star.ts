/**
 * A collaborator on an app reaches nothing in a tenant's Star, from any page they can open.
 *
 * A collaborator holds two memberships: a plain one in the app, and an admin one in its `.dev`
 * Star, where they test. A tenant's Star is a sibling of `.dev` and sits below the app, so neither
 * membership should reach it. The admin bit is the dangerous half: a check that read it without
 * asking where it was earned would hand a collaborator every tenant's data.
 *
 * The owner founds the app and a tenant Star by a real login, and the collaborator is enrolled by
 * the real node invite at the chat node, followed as sent. The first assertion is that the
 * collaborator really holds both memberships, the admin one included.
 *
 *  1. **From `.dev`'s host, where the collaborator is admin, the tenant Star refuses them**, by
 *     the passage message naming both scopes. The same client reads `.dev`'s own tree, so the
 *     call it makes is one that works. Mutation: let passage through everywhere, and the read
 *     lands.
 *  2. **From the app's page, where they are a plain member, the tenant Star refuses them** the
 *     same way. The owner's same call from the same page answers the Star's tree. Mutation: let
 *     dominion hold without the admin bit, and the collaborator's read lands while limb 1 holds.
 *  3. **On the tenant Star's own host their cookies mint no token.** The refresh answers 401 to
 *     the app cookie, and to the `.dev` one, which names another scope. The owner's cookie mints
 *     one there. Mutation: let a plain membership above the host mint, and the app cookie gets a
 *     token.
 *
 * Not driven here: the agent. Its turn runs on the Galaxy under the poster's claims, and its tools
 * reach a Star only through a preview tab, which is a page on `.dev`.
 */
import assert from 'node:assert/strict';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { ROOT_NODE_ID } from '@lumenize/resources/client';
import type { NodeInviteAck, OrgTreeState } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID } from '@lumenize/nebula/client';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import {
  provisionAndLogin, refreshAccessToken, refreshTokenForScope, setCookieHeaders, consumeLink,
} from '../../test/lib/email-login';

/** Auth and the orgTree only, never a build, so the boot skips Docker. */
export const needsContainer = false;

const APP = `${testSlug('coll')}.app`;
const DEV = `${APP}.dev`;
const TENANT = `${APP}.${testSlug('ten')}`;

/** What a refused call rejected with, or a failure if it was allowed. */
async function refusal(call: Promise<unknown>, what: string): Promise<Error> {
  const outcome = await call.then(() => undefined, (error: Error) => error);
  assert.ok(outcome, `${what} must be refused, and it landed`);
  return outcome;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const drivers: Driver[] = [];
  const connect = async (scope: string, session: { accessToken: string; sub: string }): Promise<Driver> => {
    const driver = await connectDriver(stack, { scope, session, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION });
    drivers.push(driver);
    return driver;
  };
  const treeOf = (driver: Driver, star: string): Promise<OrgTreeState> =>
    driver.client.lmz.callAsync('STAR', star, driver.client.ctn<Star>().resources.orgTree.getState());

  try {
    // The owner's one real login founds the app and the tenant Star.
    const owner = await provisionAndLogin({ baseUrl: origin, scope: TENANT, testToken });
    const ownerOnApp = await connect(APP, await refreshAccessToken(origin, owner.session, APP));

    // The collaborator, by the real node invite at the chat node, followed as sent.
    const email = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: APP, to: email, timeout: 60_000 });
    let cookies: string[];
    try {
      const ack = await ownerOnApp.client.lmz.callAsync('GALAXY', APP,
        ownerOnApp.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email, tier: 'write' }])) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      const mail = await waiter.emailPromise;
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
      assert.ok(href, 'the invite email carried no accept link');
      cookies = setCookieHeaders(await consumeLink(href.replace(/&amp;/g, '&'), fetch, { nickname: 'Collaborator' }));
    } finally {
      waiter.cleanup();
    }
    const appCookie = refreshTokenForScope(cookies, APP);
    const devCookie = refreshTokenForScope(cookies, DEV);
    assert.ok(appCookie && devCookie, 'the acceptance must set a cookie for the app and one for .dev');
    const onApp = await refreshAccessToken(origin, { refreshToken: appCookie, authScope: APP }, APP, fetch);
    const onDev = await refreshAccessToken(origin, { refreshToken: devCookie, authScope: DEV }, DEV, fetch);
    const adminBit = (token: string) =>
      (parseJwtUnsafe(token)!.payload as { access?: { scopeAdmin?: boolean } }).access?.scopeAdmin === true;
    // The dangerous shape, asserted: an admin bit earned beside the tenant Star, none above it.
    assert.deepEqual([adminBit(onApp.accessToken), adminBit(onDev.accessToken)], [false, true],
      'a collaborator is a plain member of the app and the admin of its .dev Star');

    // ── LIMB 1: from .dev's host, where the collaborator is admin ──
    {
      const collaborator = await connect(DEV, onDev);
      const own = await treeOf(collaborator, DEV);
      assert.ok(own.nodes.has(ROOT_NODE_ID), 'the collaborator must read the tree of the Star they administer');
      const refused = await refusal(treeOf(collaborator, TENANT), 'a read of the tenant Star from .dev\'s host');
      assert.match(refused.message, new RegExp(`No passage from "${DEV}" into "${TENANT}"`), `refused as: ${refused.message}`);
      console.error('  ✓ limb 1 — from .dev\'s host the collaborator reads .dev\'s tree and has no passage into the tenant Star');
    }

    // ── LIMB 2: from the app's page, where the collaborator is a plain member ──
    {
      const tenantTree = await treeOf(ownerOnApp, TENANT);
      assert.ok(tenantTree.nodes.has(ROOT_NODE_ID), 'the owner must read the tenant Star\'s tree from the app\'s page');
      const collaborator = await connect(APP, onApp);
      const refused = await refusal(treeOf(collaborator, TENANT), 'a read of the tenant Star from the app\'s page');
      assert.match(refused.message, new RegExp(`No passage from "${APP}" into "${TENANT}"`), `refused as: ${refused.message}`);
      console.error('  ✓ limb 2 — from the app\'s page the owner reads the tenant Star and the collaborator has no passage into it');
    }

    // ── LIMB 3: on the tenant Star's own host the collaborator's cookies mint nothing ──
    {
      const ownerThere = await refreshAccessToken(origin, owner.session, TENANT);
      assert.ok(ownerThere.accessToken, 'the owner\'s cookie must mint on the tenant Star\'s host');
      for (const [name, session] of [['app', { refreshToken: appCookie, authScope: APP }], ['.dev', { refreshToken: devCookie, authScope: DEV }]] as const) {
        const refused = await refusal(refreshAccessToken(origin, session, TENANT, fetch), `a refresh on the tenant Star's host with the ${name} cookie`);
        assert.match(refused.message, /^refresh-token 401/, `the ${name} cookie was answered: ${refused.message}`);
      }
      console.error('  ✓ limb 3 — on the tenant Star\'s host the owner\'s cookie mints and neither of the collaborator\'s does');
    }
  } finally {
    for (const driver of drivers) driver.dispose();
  }
}
