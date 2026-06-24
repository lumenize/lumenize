/**
 * Nebula-branded email sender.
 *
 * Extends CloudflareEmailSender with Nebula branding.
 * Customize templates in follow-on work (see tasks/nebula-auth.md § Email Template Customization).
 */
import { CloudflareEmailSender } from '@lumenize/auth';

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

export class NebulaEmailSender extends CloudflareEmailSender {
  from: string;
  appName = 'Nebula';

  /**
   * The from-address is env-configurable via `AUTH_EMAIL_FROM` (default: the branded
   * `auth@nebula.lumenize.com`). A test harness — or a `wrangler dev` lane — overrides
   * it to a domain VERIFIED on the Cloudflare account (e.g. `test@lumenize.io`): CF Email
   * Sending silently drops mail from an unverified from-address, so the real-email
   * round-trip only works from a verified domain. Production leaves it unset → the
   * branded default. (`env` is `any` to avoid coupling this shared package to any one
   * consumer's generated `Env`; it only reads the one optional var.)
   */
  constructor(ctx: ExecutionContext, env: any) {
    super(ctx, env);
    this.from = env?.AUTH_EMAIL_FROM || 'auth@nebula.lumenize.com';
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
