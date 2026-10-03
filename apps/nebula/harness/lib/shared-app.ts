/**
 * The app a run's scenarios share, and the cleanup that hands back what a scenario claimed.
 *
 * On the deployed test target every app orders a certificate pack, which a zone holds a hundred of,
 * and its host fails its TLS handshake for two and a half to four minutes until the pack is active.
 * So a run claims one account and its first app, `test-1003-runab12cd.test-1003-appef34gh`, through
 * the real signup, and every scenario that only needs an app to work in founds tenant Stars of its
 * own beneath it: a tenant rides the app's wildcard, so it costs no pack and no wait. A scenario
 * whose subject is a claim, a signup, a deletion or anything else the shared app would carry into the
 * next scenario claims an account of its own, and when it ends, pass or fail, the harness deletes
 * every account it claimed (`deleteClaimedUniverses`), which deletes each app's pack.
 *
 * The share is keyed on the stack and the run: a deployed target is one stack across a run's
 * scenarios, so they share, and every local boot is a stack of its own with empty storage, so each
 * scenario makes its own with the same code. The record holds names and an address, never a
 * credential; the owner signs in by email like anyone else.
 */
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from './harness';
import { connectDriver, scopeUrlOf } from './harness';
import { waitForHost } from './wait-for-host';
import { testSlug } from './test-scopes';
import { cachedApp, sharedAppFile, type SharedApp } from './shared-app-record';

export type { SharedApp } from './shared-app-record';
import {
  claimedUniverses, provisionAndLogin, requestMagicLink, consumeLink, refreshTokenForScope, setCookieHeaders,
  refreshAccessToken,
} from '../../test/lib/email-login';

/**
 * The run's shared app on `stack`, claimed through the real signup the first time a run asks. Resolves
 * once the app's host answers, so on a deployed target the first ask waits out its certificate and
 * every later one finds it ready; its wildcard covers each tenant Star beneath.
 */
export async function sharedApp(stack: DevStack, testToken: string): Promise<SharedApp> {
  const app = await cachedApp(sharedAppFile(stack.id), async () => {
    const universe = testSlug('run');
    const appSlug = testSlug('app');
    const ownerEmail = uniqueTestEmail();
    await provisionAndLogin({ baseUrl: stack.baseUrl, scope: `${universe}.${appSlug}`, email: ownerEmail, testToken });
    // The run's, not this scenario's: no scenario's cleanup deletes it.
    const mine = claimedUniverses.findIndex((c) => c.universe === universe);
    if (mine >= 0) claimedUniverses.splice(mine, 1);
    return { universe, galaxy: `${universe}.${appSlug}`, ownerEmail };
  });
  await waitForHost(scopeUrlOf(stack, app.galaxy));
  return app;
}

/**
 * The run's shared app, and its owner signed in through the real login on `scope`'s page, the app
 * itself when no scope is named. A Star `scope` beneath the app is founded first, by its own
 * claimer, as `provisionAndLogin` founds every tenant; name one no other scenario uses, with
 * `testSlug`.
 */
export async function asSharedOwner(
  stack: DevStack, testToken: string, scope?: string,
): Promise<{ app: SharedApp; session: { accessToken: string; sub: string } }> {
  const app = await sharedApp(stack, testToken);
  const { accessToken, sub } = await provisionAndLogin({
    baseUrl: stack.baseUrl, scope: scope ?? app.galaxy, email: app.ownerEmail, testToken,
  });
  return { app, session: { accessToken, sub } };
}

/**
 * Delete every accepted account a claim in this process wrote, as its owner from the account's own
 * page, which deletes each app's certificate pack. An account its owner never accepted ordered no
 * pack and is left, and so is one a scenario already deleted. Never throws: each outcome is reported.
 */
export async function deleteClaimedUniverses(stack: DevStack, testToken: string, report: (line: string) => void): Promise<void> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  for (const { universe, email } of claimedUniverses.splice(0)) {
    try {
      const waiter = waitForEmail({ testToken, to: email, timeout: 60_000 });
      let link: string;
      try {
        await requestMagicLink({ baseUrl: origin, email });
        link = extractMagicLink(await waiter.emailPromise);
      } finally {
        waiter.cleanup();
      }
      const refreshToken = refreshTokenForScope(setCookieHeaders(await consumeLink(link)), universe);
      if (!refreshToken) { report(`left ${universe}: its owner holds no membership there now`); continue; }
      let session: { accessToken: string; sub: string };
      try {
        session = await refreshAccessToken(origin, { refreshToken, authScope: universe }, universe);
      } catch (e) {
        // A 401 is an unaccepted claim, which ordered no pack; anything else may have left one.
        report(/refresh-token 401/.test((e as Error).message)
          ? `left ${universe}: its claim was never accepted, so it ordered no pack`
          : `could not delete ${universe}: ${(e as Error).message}`);
        continue;
      }
      const owner = await connectDriver(stack, { scope: universe, session });
      try {
        await owner.client.scopes.delete(universe);
        report(`deleted ${universe}`);
      } finally {
        owner.dispose();
      }
    } catch (e) {
      report(`could not delete ${universe}: ${(e as Error).message}`);
    }
  }
}
