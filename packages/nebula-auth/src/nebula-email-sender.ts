/**
 * Nebula-branded email sender.
 *
 * Extends `AuthEmailSenderBase` with Nebula branding; the provider is auto-detected
 * from the env (Cloudflare via the `EMAIL` binding in Nebula deployments).
 * Customize templates in follow-on work (see tasks/nebula-auth.md § Email Template Customization).
 */
import { AuthEmailSenderBase } from '@lumenize/auth';

/**
 * Matches the `instanceName` segment of a Nebula magic-link URL.
 *
 * Expected URL shape: `${baseUrl}${prefix}/${instanceName}/magic-link?one_time_token=...`
 * — produced by `NebulaAuth` in `packages/nebula-auth/src/nebula-auth.ts:239`.
 * The `instanceName` is a 1-3 dot-separated slug like `acme.app.tenant-a`.
 *
 * Anchored to `/magic-link?` to avoid false matches on other path segments.
 */
const MAGIC_LINK_INSTANCE_RE = /\/auth\/([^/]+)\/magic-link\?/;

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
   * Tag every magic-link email with `X-Lumenize-Auth-Instance: ${instanceName}`,
   * making the originating instance addressable by downstream Email Routing
   * consumers (test rigs, log filters, etc.) without parsing the body.
   *
   * Falls back to `{}` if the URL doesn't match the expected Nebula route
   * shape — the magic-link still sends, just without the routing tag.
   */
  override magicLinkHeaders(message: { magicLinkUrl: string }): Record<string, string> {
    const match = MAGIC_LINK_INSTANCE_RE.exec(message.magicLinkUrl);
    if (!match) return {};
    return { 'X-Lumenize-Auth-Instance': match[1]! };
  }
}
