/**
 * NebulaClientGateway — extends LumenizeClientGateway with active-scope verification.
 *
 * `onBeforeCallToClient` gates deliver-to-client pushes on a same-`aud` check (a subscriber only
 * receives pushes originating in its own active scope) — EXCEPT for pushes from the global `Profile`
 * DO, which are intentionally cross-scope (see the PROFILE-fence below).
 */

import { LumenizeClientGateway } from '@lumenize/mesh';
import type { CallEnvelope, GatewayConnectionInfo } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

export class NebulaClientGateway extends LumenizeClientGateway {
  override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
    // PROFILE-fence (ADR-012; tasks/archive/nebula-profile-store.md § Routing model): a push from the global
    // Profile DO carries PUBLIC fields ONLY and public profile read is OPEN to any authenticated caller
    // holding the profileId, so cross-scope delivery is intentional — skip the same-aud check. `metadata.caller`
    // is stamped by the trusted mesh (never the client); a hand-rolled fanout (no tier hop) keeps it
    // reliably `PROFILE` at any N. Absent metadata falls through to the aud check (fail-closed). Every
    // other push (STAR / DEV_STUDIO / …) keeps the same-Star aud gate, behavior-identical.
    if (envelope.metadata?.caller?.bindingName === 'PROFILE') return;

    const aud = (envelope.callContext.originAuth?.claims as NebulaJwtPayload | undefined)?.aud;
    if (aud !== connectionInfo.claims.aud) {
      throw new Error('Active-scope mismatch on call to client');
    }
  }
}
