import { hasDominionOver } from '@lumenize/mesh';
import type { AuthClaims } from '@lumenize/mesh';

/**
 * Whether `claims` hold dominion over the host the plane runs on, which admits them to every node
 * of its tree with no grant: an admin of `acme.crm` reading on `acme.crm`'s Galaxy, say.
 *
 * ⚠️ It reads `hasDominionOver(claims, hostName)` and never the bare `access.scopeAdmin` bit. Passage
 * admits a caller whose own scope sits BELOW the host, so the bit alone would let an admin of
 * `acme.crm.dev` read every node of `acme.crm` (tasks/archive/nebula-confine-admin-bypass.md).
 * An unknown host name grants nothing, so the caller falls through to their grants.
 *
 * A subscription stores this verdict on its row, since its pushes hold no token, and a one-time
 * query read computes it live, and `OrgTree.requirePermission` checks it on a live call; all three
 * call this one function.
 */
export function hasDominionOverHost(claims: AuthClaims | undefined, hostName: string | undefined): boolean {
  return hostName !== undefined && hostName !== '' && hasDominionOver(claims, hostName);
}
