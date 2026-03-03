/**
 * NebulaClientGateway — extends LumenizeClientGateway with active-scope verification
 *
 * Single override: onBeforeCallToClient checks that the mesh call's
 * originAuth.claims.aud matches the connected client's aud.
 */

import { LumenizeClientGateway } from '@lumenize/mesh';
import type { CallEnvelope, GatewayConnectionInfo } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

export class NebulaClientGateway extends LumenizeClientGateway {
  override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
    const aud = (envelope.callContext.originAuth?.claims as NebulaJwtPayload | undefined)?.aud;
    if (aud !== connectionInfo.claims.aud) {
      throw new Error('Active-scope mismatch on call to client');
    }
  }
}
