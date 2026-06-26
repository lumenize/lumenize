import { debug } from '@lumenize/debug';
import type { EmailTransport } from './types';
import { CloudflareEmailTransport } from './cloudflare-email-transport';
import { ResendEmailTransport } from './resend-email-transport';

const log = debug('email.createEmailTransport');

/** Supported email providers. */
export type EmailProvider = 'cloudflare' | 'resend';

export interface CreateEmailTransportOptions {
  /**
   * Explicitly select the provider, overriding env-based auto-detection. Takes
   * precedence over the `EMAIL_PROVIDER` env var.
   */
  provider?: EmailProvider;
}

interface EmailSelectionEnv {
  EMAIL?: unknown;
  RESEND_API_KEY?: string;
  EMAIL_PROVIDER?: string;
}

/**
 * Select an {@link EmailTransport} from the environment.
 *
 * Precedence:
 *  1. `opts.provider` or `env.EMAIL_PROVIDER` — explicit selection; throws if the
 *     selected provider's credentials are absent.
 *  2. else the `EMAIL` binding is present → Cloudflare.
 *  3. else → Resend, emitting a `warn` (a deployment that lost its `EMAIL` binding
 *     falls back here — set `EMAIL_PROVIDER=resend` to make the choice explicit).
 *
 * `env` is typed `object` because this library is consumed by multiple packages
 * with different generated `Env`s; access is narrowed internally.
 *
 * @throws if an explicitly-selected provider's credentials are missing, or if
 *   `EMAIL_PROVIDER` names an unknown provider.
 */
export function createEmailTransport(
  env: object,
  opts: CreateEmailTransportOptions = {},
): EmailTransport {
  const e = env as EmailSelectionEnv;
  const explicit = opts.provider ?? (e.EMAIL_PROVIDER as EmailProvider | undefined);

  if (explicit !== undefined) {
    switch (explicit) {
      case 'cloudflare':
        if (!e.EMAIL) {
          throw new Error("createEmailTransport: provider 'cloudflare' selected but the EMAIL binding is not configured");
        }
        return new CloudflareEmailTransport(env);
      case 'resend':
        if (!e.RESEND_API_KEY) {
          throw new Error("createEmailTransport: provider 'resend' selected but RESEND_API_KEY is not set");
        }
        return new ResendEmailTransport(env);
      default:
        throw new Error(`createEmailTransport: unknown EMAIL_PROVIDER '${String(explicit)}' (expected 'cloudflare' or 'resend')`);
    }
  }

  if (e.EMAIL) {
    return new CloudflareEmailTransport(env);
  }

  // Fall-through: no binding and no explicit selection. A gated @lumenize/debug
  // warn (NOT a secret — names no key/value), so a deployment that lost its
  // EMAIL binding is noticed in dev/test rather than silently misrouting.
  log.warn('no EMAIL binding and no EMAIL_PROVIDER set; defaulting to Resend — set EMAIL_PROVIDER=resend to make provider selection explicit');
  return new ResendEmailTransport(env);
}
