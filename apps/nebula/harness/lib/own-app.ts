/**
 * An app of a scenario's own, for a scenario that builds, rewrites the ontology of, or wipes its
 * `.dev` Star. A Galaxy has exactly one `.dev` Star, so on the run's shared app such scenarios
 * would rebuild each other's ontology and erase each other's grants, and under `--concurrency`
 * they would race outright. Deployed, each app orders a certificate pack and waits two and a half
 * to four minutes for it, which is the price of that isolation.
 *
 * Every step here is one a person takes: a real login claims a fresh universe and its app, Studio
 * builds through `buildNow`, and the `.dev` page names the version its last landed build carries.
 */
import { scopeUrlOf, waitForHost } from './harness';
import type { DevStack } from './harness';
import { testSlug } from './test-scopes';
import { provisionAndLogin, refreshAccessToken } from '../../test/lib/email-login';
import type { EmailSession } from '../../test/lib/email-login';

export interface OwnApp {
  galaxy: string;
  /** The app's `.dev` Star, `{galaxy}.dev`. */
  dev: string;
  /** The universe admin's session, whose cookie refreshes at any scope beneath it. */
  session: EmailSession;
  /** Access tokens on the Galaxy's page (Studio) and on the `.dev` Star's page. */
  studio: { accessToken: string; sub: string };
  devToken: { accessToken: string; sub: string };
}

/** Claim a fresh app, `test-…-{label}….app`, and log in as its universe's admin. */
export async function ownApp(stack: Pick<DevStack, 'baseUrl'>, label: string, testToken: string): Promise<OwnApp> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  const galaxy = `${testSlug(label)}.app`;
  const dev = `${galaxy}.dev`;
  const { session } = await provisionAndLogin({ baseUrl: origin, scope: galaxy, testToken });
  return {
    galaxy,
    dev,
    session,
    studio: await refreshAccessToken(origin, session, galaxy),
    devToken: await refreshAccessToken(origin, session, dev),
  };
}

/**
 * The ontology version a page served on `star`'s host carries, read from its `nebula-scope` meta
 * the way the app's own client reads it — `undefined` when no build has landed one. Waits for the
 * host first, since a new app's host on a deployed target answers only once its certificate is.
 */
export async function servedOntologyVersion(stack: Pick<DevStack, 'baseUrl' | 'origin'>, star: string): Promise<string | undefined> {
  const page = scopeUrlOf(stack, star);
  await waitForHost(page);
  const res = await fetch(`${page}/`);
  const html = await res.text();
  const content = /<meta name="nebula-scope" content='([^']*)'>/.exec(html)?.[1];
  if (!content) throw new Error(`${star}'s page (${res.status}) carried no nebula-scope meta`);
  return (JSON.parse(content.replace(/&#39;/g, "'")) as { ontologyVersion?: string }).ontologyVersion;
}
