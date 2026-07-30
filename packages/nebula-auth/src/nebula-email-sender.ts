/**
 * Nebula-branded email sender.
 *
 * Extends `AuthEmailSenderBase` with Nebula branding; the provider is auto-detected
 * from the env (Cloudflare via the `EMAIL` binding in Nebula deployments).
 * Customize templates in follow-on work (see tasks/nebula-scratchpad.md § Email Template Customization).
 */
import { AuthEmailSenderBase, type EmailMessage } from '@lumenize/auth';
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
 * The `instanceName` a Nebula auth URL identifies, or `undefined` if `value` is not one.
 *
 * Expected shape: `${origin}${NEBULA_AUTH_PREFIX}/${instanceName}/${route}?…`, where
 * `instanceName` is a 1-3 dot-separated slug like `acme.app.tenant-a`.
 *
 * Total by design — every non-URL string a message carries (`to`, `type`, `subjectEmail`)
 * fails `new URL` and returns `undefined`, so callers may hand it anything.
 */
function parseInstanceName(value: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith(`${NEBULA_AUTH_PREFIX}/`)) return undefined;
  const segments = pathname.slice(NEBULA_AUTH_PREFIX.length + 1).split('/');
  if (segments.length !== 2) return undefined;
  const [instanceName, route] = segments;
  if (!instanceName || !INSTANCE_BEARING_ROUTES.has(route!)) return undefined;
  return instanceName;
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
   * Tag every outbound mail with the instance its URL identifies, making the originating
   * instance addressable by downstream Email Routing consumers (test rigs, log filters)
   * without parsing the body.
   *
   * ⚠️ **The message type is deliberately never consulted.** The rule is a property of the
   * URL, not of the mail: *if a message carries a Nebula auth URL, that URL names the
   * instance.* So `invite-existing`, `admin-notification` and `approval-confirmation` need
   * no decision here — today they carry app-redirect URLs with no instance segment and come
   * out untagged, and the day one of them carries an instance-bearing URL it is tagged with
   * no change to this file. That totality is the point: the previous per-type shape shipped
   * magic-link tagged and invite untagged, and the failure was silent — an untagged mail
   * lands in the email-test catch-all bucket, so `waitForEmail({ instance })` never matches
   * and the caller dies on its timeout with nothing pointing at the sender.
   *
   * First match wins. Each `EmailMessage` variant carries exactly one URL, so there is
   * nothing to disambiguate; a variant with two would need this revisited.
   */
  override headers(message: EmailMessage): Record<string, string> {
    for (const value of Object.values(message)) {
      if (typeof value !== 'string') continue;
      const instanceName = parseInstanceName(value);
      if (instanceName !== undefined) return { [INSTANCE_HEADER]: instanceName };
    }
    return {};
  }
}
