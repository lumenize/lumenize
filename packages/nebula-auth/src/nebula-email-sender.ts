/**
 * Nebula-branded email sender.
 *
 * Extends `AuthEmailSenderBase` with Nebula branding; the provider is auto-detected
 * from the env (Cloudflare via the `EMAIL` binding in Nebula deployments).
 * Customize templates in follow-on work (see tasks/nebula-scratchpad.md § Email Template Customization).
 */
import { AuthEmailSenderBase } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from './types';

/**
 * Routing tag downstream Email Routing consumers bucket by — `tooling/email-test`'s
 * `EmailTestDO` files each received email under this header's value, which is what
 * `waitForEmail({ instance })` subscribes to.
 */
const INSTANCE_HEADER = 'X-Lumenize-Auth-Instance';

/**
 * The auth routes whose URL carries the `instanceName` segment. Both are built by the
 * registry — `#magicLinkUrl` and `issueInvites` in `nebula-auth-registry.ts`.
 *
 * ⚠️ Matching the route EXACTLY is what makes `#instanceHeaders` safe: without it, any
 * two-segment path under the prefix would have its first segment read as an instance.
 */
const INSTANCE_BEARING_ROUTES = new Set(['magic-link', 'accept-invite']);

/**
 * Parse the `instanceName` out of a Nebula auth URL and return it as the routing header.
 *
 * Expected URL shape: `${origin}${NEBULA_AUTH_PREFIX}/${instanceName}/${route}?…`, where
 * `instanceName` is a 1-3 dot-separated slug like `acme.app.tenant-a`.
 *
 * Returns `{}` for anything else — an unparseable URL or a route that carries no instance —
 * so the email still sends, just without the routing tag.
 */
function instanceHeaders(url: string): Record<string, string> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return {};
  }
  if (!pathname.startsWith(`${NEBULA_AUTH_PREFIX}/`)) return {};
  const segments = pathname.slice(NEBULA_AUTH_PREFIX.length + 1).split('/');
  if (segments.length !== 2) return {};
  const [instanceName, route] = segments;
  if (!instanceName || !INSTANCE_BEARING_ROUTES.has(route!)) return {};
  return { [INSTANCE_HEADER]: instanceName };
}

export class NebulaEmailSender extends AuthEmailSenderBase {
  from: string;
  appName = 'Nebula';

  /**
   * The from-address is env-configurable via `AUTH_EMAIL_FROM`. Default is the
   * verified `noreply@lumenize.io` — a pre-alpha stopgap (`lumenize.io` is verified
   * on BOTH Cloudflare Email Sending and Resend, so mail actually sends; an
   * unverified from-domain is silently dropped by CF / rejected by Resend). The
   * brand-aligned target is `noreply@nebula.lumenize.com` (matches the app origin +
   * JWT issuer); it's now Resend-verified — the switch + its DMARC record are tracked
   * in `tasks/backlog.md` (§ Nebula email sender domain). A test harness / `wrangler
   * dev` lane overrides this to `test@lumenize.io` so the deployed email-test Worker
   * catches the round-trip. (`env` is `any` to avoid coupling this shared package to
   * any one consumer's generated `Env`; it only reads the one optional var.)
   */
  constructor(ctx: ExecutionContext, env: any) {
    super(ctx, env);
    this.from = env?.AUTH_EMAIL_FROM || 'noreply@lumenize.io';
  }

  /**
   * Tag the magic-link email with the originating instance, making it addressable by
   * downstream Email Routing consumers (test rigs, log filters) without parsing the body.
   */
  override magicLinkHeaders(message: { magicLinkUrl: string }): Record<string, string> {
    return instanceHeaders(message.magicLinkUrl);
  }

  /**
   * Same tag on the invite email — it is the second (and only other) mail Nebula sends,
   * and it is equally something a test lane needs to wait for by instance.
   *
   * ⚠️ Its absence was a silent failure, not a missing nicety: an untagged email lands in
   * the email-test catch-all bucket, so `waitForEmail({ instance })` never matches and the
   * caller dies on its timeout with nothing pointing at the sender. Any new instance-bearing
   * mail needs its header hook overridden here too.
   *
   * `inviteExistingHeaders` deliberately stays unoverridden: Nebula never sends that type
   * (only `@lumenize/auth`'s own `LumenizeAuth` DO does), and its `redirectUrl` is the app
   * redirect — it has no `/auth/{instanceName}/…` segment to parse.
   */
  override inviteNewHeaders(message: { inviteUrl: string }): Record<string, string> {
    return instanceHeaders(message.inviteUrl);
  }
}
