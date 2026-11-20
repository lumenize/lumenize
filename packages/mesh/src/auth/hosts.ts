/**
 * Which host is which — ADR-021's grammar, read against the deployment's own origin.
 *
 * A deployment names its origin once, as the `LUMENIZE_ORIGIN` var: `https://lumenize.dev` in
 * production, `https://lumenize-test.dev` on the deployed test target, `http://lumenize.localhost`
 * on a local stack. Every host is read against it by stripping that suffix and reading the labels
 * right to left, so `tenant1.crm.acme.lumenize.localhost:54321` is the scope `acme.crm.tenant1`
 * exactly as `tenant1.crm.acme.lumenize.dev` is.
 *
 * Pure, with no `cloudflare:workers` in its graph, so vite's config and the Node harness import it
 * through Mesh's `/client` subpath.
 */
import { isValidSlug } from './parse-id';
import { RESERVED_UNIVERSE_SLUGS } from './types';

/** The shortest persona slug: a label with `--` as its third and fourth characters is punycode's. */
const MIN_PERSONA_SLUG_LENGTH = 3;

/**
 * Whether `slug` can name a persona: a slug of 3 to 30 characters, so `mary--dev` is one DNS label
 * whose persona part no reader takes for punycode. The one grammar a persona's host, its address
 * and a cast's slug all answer to.
 */
export function isPersonaSlug(slug: string): boolean {
  return typeof slug === 'string' && slug.length >= MIN_PERSONA_SLUG_LENGTH && isValidSlug(slug);
}

/**
 * The Stars a persona may live in: ones with no real users, so a test user is never beside a real
 * one. Only `dev` today. This is the one place that says which, and {@link parseHost} reads it, so a
 * persona's labels under any other Star are no host, and so no address, page or token.
 */
export const PERSONA_STAR_SLUGS: ReadonlySet<string> = new Set(['dev']);

/**
 * What a host is. `platform` is the host that serves the session lifecycle, `platform.lumenize.dev`,
 * which is not the platform SCOPE `_platform`, the root of the scope tree; the two are never used
 * for each other, and no host label can start with the scope's underscore. `apex` is the bare
 * origin host.
 */
export type HostTarget =
  | { kind: 'apex' }
  | { kind: 'platform' }
  | { kind: 'scope'; scope: string }
  | { kind: 'persona'; persona: string; scope: string };

/**
 * Parse `host`, with or without a port, against `origin`. `null` for anything the grammar refuses:
 * a host outside the origin, a label the slug grammar refuses, more labels than a Star, a universe
 * label the platform keeps, a persona under a Star outside {@link PERSONA_STAR_SLUGS}, or a first label with
 * more than one `--`.
 *
 * @example parseHost('manny--dev.crm.acme.lumenize.dev', 'https://lumenize.dev')
 *          // → { kind: 'persona', persona: 'manny', scope: 'acme.crm.dev' }
 */
export function parseHost(host: string, origin: string): HostTarget | null {
  const suffix = new URL(origin).hostname;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  if (name === suffix) return { kind: 'apex' };
  if (!name.endsWith(`.${suffix}`)) return null;
  const labels = name.slice(0, -(suffix.length + 1)).split('.');
  if (labels.length === 1 && labels[0] === 'platform') return { kind: 'platform' };
  if (labels.length > 3) return null;

  const [first, ...rest] = labels;
  const parts = first.split('--');
  if (parts.length > 2) return null;
  let persona: string | undefined;
  let leftmost = first;
  if (parts.length === 2) {
    // A persona joins its Star's label, and that Star is one with no real users.
    if (labels.length !== 3 || !PERSONA_STAR_SLUGS.has(parts[1])) return null;
    if (!isPersonaSlug(parts[0])) return null;
    [persona, leftmost] = parts;
  }
  const scopeLabels = [leftmost, ...rest].reverse();
  if (!scopeLabels.every(isValidSlug)) return null;
  if (RESERVED_UNIVERSE_SLUGS.has(scopeLabels[0])) return null;
  const scope = scopeLabels.join('.');
  return persona ? { kind: 'persona', persona, scope } : { kind: 'scope', scope };
}

/**
 * The platform host's origin for a deployment: `https://lumenize.dev` → `https://platform.lumenize.dev`.
 * It is also the deployment's JWT issuer, so each deployment issues and accepts only its own tokens.
 */
export function platformOrigin(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//platform.${url.hostname}`;
}

/**
 * The origin of one of this deployment's hosts: the platform host, a scope's own host, its labels
 * the scope's read right to left, or a persona's, whose first label is `{persona}--{star slug}`. The
 * port is the request's, since a local stack answers every host on one port, and production's
 * requests carry none. {@link parseHost} reads each back to the target it was spelled from.
 *
 * @throws for a persona that is not a persona slug (`isPersonaSlug`), so no input spells another
 *   site's origin through a persona's label.
 *
 * @example hostOrigin({ kind: 'scope', scope: 'acme.crm' }, 'http://lumenize.localhost', 'http://platform.lumenize.localhost:5174')
 *          // → 'http://crm.acme.lumenize.localhost:5174'
 */
export function hostOrigin(
  target: { kind: 'platform' } | { kind: 'scope'; scope: string } | { kind: 'persona'; persona: string; scope: string },
  origin: string,
  requestOrigin?: string,
): string {
  const deployment = new URL(origin);
  const port = requestOrigin ? new URL(requestOrigin).port : '';
  const labels = target.kind === 'platform' ? ['platform'] : target.scope.split('.').reverse();
  if (target.kind === 'persona') {
    if (!isPersonaSlug(target.persona)) throw new Error(`Not a persona slug: ${JSON.stringify(target.persona)}`);
    labels[0] = `${target.persona}--${labels[0]}`;
  }
  return `${deployment.protocol}//${labels.join('.')}.${deployment.hostname}${port ? `:${port}` : ''}`;
}

/**
 * The URL a `return_to` may name, or `null`: an absolute URL carrying the deployment's own scheme,
 * whose host the parse turns into a scope or the platform host. A scheme-relative `//evil.example`,
 * a `javascript:` or `data:` URL, and any host outside the deployment are refused.
 */
export function checkedReturnTo(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== new URL(origin).protocol) return null;
  const target = parseHost(url.host, origin);
  return target && (target.kind === 'scope' || target.kind === 'platform' || target.kind === 'persona')
    ? url.href : null;
}

/**
 * The deployment's origin, from its `LUMENIZE_ORIGIN` var. Throws when the var is absent: a
 * deployment that cannot say which hosts are its own must not guess, since the guess decides which
 * tokens it accepts.
 */
export function deploymentOrigin(env: object): string {
  const origin = (env as { LUMENIZE_ORIGIN?: string }).LUMENIZE_ORIGIN;
  if (!origin) throw new Error('LUMENIZE_ORIGIN is not set: this deployment cannot name its own hosts');
  return origin;
}

/** The longest mailbox name a mail provider will send to (RFC 5321's local part). */
const MAX_MAILBOX_NAME = 64;

/**
 * The address a persona receives mail at: its host's own labels at the deployment's persona mail
 * domain, so nothing stores the pairing. `manny` in `acme.crm.dev` at `lumenize.dev` is
 * `manny--dev.crm.acme@lumenize.dev`, as its host is `manny--dev.crm.acme.lumenize.dev`.
 *
 * A mailbox name holds at most {@link MAX_MAILBOX_NAME} characters, which two long slugs pass, and
 * the provider refuses to send to a longer one. There the app's two labels are replaced by 16 hex
 * characters of their SHA-256, `manny--dev.5f0c2a9be1d47c33@lumenize.dev`. So an address is always
 * spelled FORWARD, from a persona and its Star, and compared; nothing reads a Star back out of one.
 */
export async function personaAddress(target: { persona: string; scope: string }, mailDomain: string): Promise<string> {
  const [universe, galaxy, star] = target.scope.split('.');
  const head = `${target.persona}--${star}`;
  const app = `${galaxy}.${universe}`;
  let name = `${head}.${app}`;
  if (name.length > MAX_MAILBOX_NAME) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(app)));
    name = `${head}.${Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `${name}@${mailDomain}`.toLowerCase();
}

/**
 * The persona slug an address's mailbox name opens with, or `null` for an address at another domain
 * or one that is not shaped as a persona's: `{persona}--{star}.` and then the app, with the Star in
 * {@link PERSONA_STAR_SLUGS}. It says an address is a persona's by its SHAPE. Whose persona it is
 * comes from spelling {@link personaAddress} forward for a Star something trusted names.
 */
export function personaSlugOfAddress(address: string, mailDomain: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || address.slice(at + 1).toLowerCase() !== mailDomain.toLowerCase()) return null;
  const match = /^([^.]+)--([^.]+)\.(.+)$/.exec(address.slice(0, at).toLowerCase());
  if (!match || !PERSONA_STAR_SLUGS.has(match[2]!)) return null;
  return isPersonaSlug(match[1]!) ? match[1]! : null;
}

/**
 * The domain a deployment's personas receive mail at, from its `PERSONA_MAIL_DOMAIN` var: a zone
 * whose catch-all rule sends mail to this Worker. `undefined` where the deployment names none, and
 * then no persona's host opens and no mail is accepted.
 */
export function personaMailDomain(env: object): string | undefined {
  return (env as { PERSONA_MAIL_DOMAIN?: string }).PERSONA_MAIL_DOMAIN || undefined;
}
