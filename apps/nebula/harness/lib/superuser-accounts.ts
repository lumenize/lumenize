/**
 * The deployed superuser's hold on a target's accounts — what the account sweep in
 * `lib/test-scopes.ts` lists and deletes through.
 *
 * It signs in the way the superuser scenarios do, through a real magic link to
 * {@link DEPLOYED_SUPERUSER}, so it runs once per sweep, in `drive.ts`, before any scenario: two
 * sign-ins to that one address at once would race for each other's mail. The listing is Home's
 * summary, whose platform row holds every universe up to Home's budget. A delete is asked from the
 * universe's own page, since dominion is read from the host, and the superuser's membership at the
 * root is above every host.
 */
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import type { DevStack } from './harness';
import { connectDriver, DEPLOYED_SUPERUSER } from './harness';
import type { AccountSweepApi } from './test-scopes';
import {
  requestMagicLink, consumeLink, refreshTokenForScope, setCookieHeaders, acceptMembership, homeSummary,
  refreshCookie, refreshAccessToken,
} from '../../test/lib/email-login';

/** The reserved platform scope, where the superuser's one membership sits. */
const PLATFORM_SCOPE = '_platform';

/** Sign in as the deployed superuser on `stack` and hand back its list and delete. */
export async function superuserAccounts(stack: DevStack, testToken: string): Promise<AccountSweepApi> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  // `_scopeless`: the login names no scope, so its mail carries no scope tag.
  const waiter = waitForEmail({ testToken, instance: '_scopeless', to: DEPLOYED_SUPERUSER, timeout: 60_000 });
  let found: string | undefined;
  try {
    await requestMagicLink({ baseUrl: origin, email: DEPLOYED_SUPERUSER });
    found = refreshTokenForScope(setCookieHeaders(await consumeLink(extractMagicLink(await waiter.emailPromise))), PLATFORM_SCOPE);
  } finally {
    waiter.cleanup();
  }
  if (!found) throw new Error(`${DEPLOYED_SUPERUSER}'s login set no ${PLATFORM_SCOPE} cookie — is it the target's bootstrap address?`);
  const refreshToken = found;
  await acceptMembership(origin, refreshToken, PLATFORM_SCOPE);
  const session = { refreshToken, authScope: PLATFORM_SCOPE };

  return {
    async list() {
      const res = await homeSummary(origin, refreshCookie(PLATFORM_SCOPE, refreshToken));
      if (!res.ok) throw new Error(`home-summary ${res.status}: ${(await res.text()).slice(0, 200)}`);
      type Node = { scope: string; children?: Node[] };
      const { groups } = await res.json() as { groups: { summary: { emails?: { memberships?: Node[] }[] } }[] };
      return groups
        .flatMap((g) => (g.summary.emails ?? []).flatMap((e) => e.memberships ?? []))
        .filter((n) => n.scope === PLATFORM_SCOPE)
        .flatMap((n) => (n.children ?? []).map((child) => child.scope));
    },
    async delete(universe) {
      const driver = await connectDriver(stack, { scope: universe, session: await refreshAccessToken(origin, session, universe) });
      try {
        // The client stands on the account's page, so its socket closes before the answer arrives.
        await driver.client.scopes.delete(universe).catch((e: Error) => { if (e.name !== 'HostDeletedError') throw e; });
      } finally {
        driver.dispose();
      }
    },
  };
}
