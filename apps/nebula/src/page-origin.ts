/**
 * What a page knows about the deployment it was served from: the origin the serving layer names in
 * `<meta name="lumenize-origin">`, and the platform host's origin derived from it at the page's own
 * port. Browser-safe and pure but for the one DOM read.
 */
import { hostOrigin } from '@lumenize/nebula-auth/claims';
import { LUMENIZE_ORIGIN_META } from './page-meta';

/** The deployment origin the page's `lumenize-origin` meta names, or `undefined` off a served page. */
export function deploymentOriginOfPage(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.querySelector(`meta[name="${LUMENIZE_ORIGIN_META}"]`)?.getAttribute('content') ?? undefined;
}

/** The platform host's origin for `deployment`, at `pageOrigin`'s port. */
export function platformOriginOf(deployment: string, pageOrigin: string): string {
  return hostOrigin({ kind: 'platform' }, deployment, pageOrigin);
}
