/**
 * NebulaClientGateway — a tab receives a node's call only if its holder has passage into the node.
 *
 * The sender is the call's last hop, `callChain.at(-1)`, which the mesh stamps and no client can
 * write. Its scope is its name when that parses as one: a Galaxy reaches a tab on one of its Stars'
 * hosts, since upward is free, and a sibling Star is refused as lateral (ADR-015). A Star
 * `acme.crm.tenant2` pushing to a tab on `acme.crm.tenant1`'s host is refused; the Galaxy
 * `acme.crm` pushing there passes. A sender whose name is no scope, the `Profile`, passes, so a
 * node not named by a scope must hold no tenant's data.
 *
 * It is needed because a server-side node can address any Client whose name it holds, and this is
 * what stops a lateral one. It reads the sender's address and no claims of the writer's, so a push
 * that starts a fresh chain passes it.
 *
 * A sender that is itself a Client is not checked here. A tab is named `{sub}.{tabId}`, not by a
 * scope, so it offers no scope to check passage into; the receiving Client decides, and
 * `LumenizeClient.onBeforeCall` refuses it by default.
 */

import { LumenizeClientGateway } from '@lumenize/mesh';
import type { CallEnvelope, GatewayConnectionInfo } from '@lumenize/mesh';
import { hasPassageInto, noPassageMessage, parseId } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

/** A node's scope is its name when that parses as one; anything else names none. */
function scopeNamed(instanceName: string | undefined): string | undefined {
  if (!instanceName) return undefined;
  try { return parseId(instanceName).raw; } catch { return undefined; }
}

export class NebulaClientGateway extends LumenizeClientGateway {
  override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): undefined {
    const sender = envelope.callContext.callChain.at(-1);
    if (!sender) throw new Error('Call to a client names no sender');

    // Another Client: the receiving Client decides (see the class comment).
    if (sender.type === 'LumenizeClient') return;

    const senderScope = scopeNamed(sender.instanceName);
    if (senderScope === undefined) return;

    const claims = connectionInfo.claims as unknown as NebulaJwtPayload;
    if (!hasPassageInto(claims, senderScope)) {
      throw new Error(noPassageMessage(claims?.aud, senderScope));
    }
  }
}
