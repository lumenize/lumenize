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
 * The fixed namespace every persona's id is computed in (RFC 9562 § 5.5). Changing it changes every
 * persona's `sub` and `profileId` at once, orphaning their grants and Profiles.
 */
export const PERSONA_NAMESPACE = '68acba14-ab9b-4cdc-9340-fd6d0b976a4f';

/**
 * A persona's `sub` and `profileId`: one version-5 UUID of its name in its Star,
 * `acme.crm.dev/manny`. Deterministic, so the refresh derives it from the host and nothing stores
 * it; and a person's ids come from `crypto.randomUUID()`, which always writes version 4, so no
 * persona's id can equal a person's — by construction, not by odds.
 */
export async function personaId(star: string, persona: string): Promise<string> {
  const ns = PERSONA_NAMESPACE.replace(/-/g, '');
  const name = new TextEncoder().encode(`${star}/${persona}`);
  const input = new Uint8Array(16 + name.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  input.set(name, 16);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // the RFC variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
