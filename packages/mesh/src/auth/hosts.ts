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
import { RESERVED_STAR_SLUGS, RESERVED_UNIVERSE_SLUGS } from './types';

/** The shortest persona slug: a label with `--` as its third and fourth characters is punycode's. */
const MIN_PERSONA_SLUG_LENGTH = 3;

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
 * label the platform keeps, a persona under a Star that is no environment, or a first label with
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
    // A persona joins its Star's label, and that Star is always an environment, never a tenant.
    if (labels.length !== 3 || !RESERVED_STAR_SLUGS.has(parts[1])) return null;
    if (parts[0].length < MIN_PERSONA_SLUG_LENGTH || !isValidSlug(parts[0])) return null;
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
 * The origin of one of this deployment's hosts: the platform host, or a scope's own host, its labels
 * the scope's read right to left. The port is the request's, since a local stack answers every host
 * on one port, and production's requests carry none.
 *
 * @example hostOrigin({ kind: 'scope', scope: 'acme.crm' }, 'http://lumenize.localhost', 'http://platform.lumenize.localhost:5174')
 *          // → 'http://crm.acme.lumenize.localhost:5174'
 */
export function hostOrigin(
  target: { kind: 'platform' } | { kind: 'scope'; scope: string },
  origin: string,
  requestOrigin?: string,
): string {
  const deployment = new URL(origin);
  const port = requestOrigin ? new URL(requestOrigin).port : '';
  const label = target.kind === 'platform' ? 'platform' : target.scope.split('.').reverse().join('.');
  return `${deployment.protocol}//${label}.${deployment.hostname}${port ? `:${port}` : ''}`;
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

/**
 * The address a persona receives mail at: its host's own labels at the deployment's persona mail
 * domain, so nothing stores the pairing. `manny` in `acme.crm.dev` at `lumenize.dev` is
 * `manny--dev.crm.acme@lumenize.dev`, as its host is `manny--dev.crm.acme.lumenize.dev`.
 */
export function personaAddress(target: { persona: string; scope: string }, mailDomain: string): string {
  const [universe, galaxy, star] = target.scope.split('.');
  return `${target.persona}--${star}.${galaxy}.${universe}@${mailDomain}`.toLowerCase();
}

/**
 * The persona and Star an address spells, or `null` for an address at another domain or one whose
 * local part is no persona's host labels. The labels are read by {@link parseHost}, so an address
 * names a persona exactly when the same labels would be a persona's host.
 */
export function personaOfAddress(address: string, mailDomain: string): { persona: string; scope: string } | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || address.slice(at + 1).toLowerCase() !== mailDomain.toLowerCase()) return null;
  const target = parseHost(`${address.slice(0, at)}.host.invalid`, 'https://host.invalid');
  return target?.kind === 'persona' ? { persona: target.persona, scope: target.scope } : null;
}

/**
 * The domain a deployment's personas receive mail at, from its `PERSONA_MAIL_DOMAIN` var: a zone
 * whose catch-all rule sends mail to this Worker. `undefined` where the deployment names none, and
 * then no persona's host opens and no mail is accepted.
 */
export function personaMailDomain(env: object): string | undefined {
  return (env as { PERSONA_MAIL_DOMAIN?: string }).PERSONA_MAIL_DOMAIN || undefined;
}
