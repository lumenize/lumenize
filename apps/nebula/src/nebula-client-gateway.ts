/**
 * NebulaClientGateway — a tab receives a node's call only if its holder has passage into the node.
 *
 * The check is {@link requirePassageIntoSender}, which every Nebula node runs for the Clients it
 * hosts; this Gateway runs the same check for a tab that still connects to a Gateway of its own.
 */

import { LumenizeClientGateway } from '@lumenize/mesh';
import type { CallEnvelope, GatewayConnectionInfo } from '@lumenize/mesh';
import { requirePassageIntoSender } from './nebula-do';

export class NebulaClientGateway extends LumenizeClientGateway {
  override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): undefined {
    requirePassageIntoSender(envelope, connectionInfo);
    return undefined;
  }
}
