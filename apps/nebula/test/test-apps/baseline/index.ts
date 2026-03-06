/**
 * Baseline test-app for Nebula e2e tests
 *
 * Re-exports all DO classes for wrangler bindings, defines test subclasses
 * (StarTest, NebulaClientTest), and provides the Worker entrypoint.
 */

import { mesh } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

// Re-export DO classes and entrypoint for wrangler bindings
export {
  NebulaClientGateway,
  Universe,
  Galaxy,
  ResourceHistory,
  entrypoint as default,
} from '@lumenize/nebula';

// Re-export auth classes (defined in nebula-auth, but wrangler needs them here)
export { NebulaAuth, NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';

// Import classes needed for test subclasses
import {
  Star,
  Universe,
  Galaxy,
  ResourceHistory,
  NebulaClient,
  requireAdmin,
} from '@lumenize/nebula';
import type { PermissionTier } from '@lumenize/nebula';

// ============================================
// Test subclass: StarTest — adds callClient for mesh→client testing
// ============================================

export class StarTest extends Star {
  @mesh(requireAdmin)
  callClient(targetGatewayInstanceName: string, clientMethod: string, ...args: any[]): void {
    const ctn = this.ctn() as any;
    this.lmz.call(
      'NEBULA_CLIENT_GATEWAY',
      targetGatewayInstanceName,
      ctn[clientMethod](...args),
    );
  }
}

// ============================================
// Test subclass: NebulaClientTest — adds @mesh methods + test initiators
// ============================================

// Guard for client-side methods
function requireAdminCaller(instance: NebulaClientTest) {
  const claims = instance.lmz.callContext.originAuth?.claims as unknown as NebulaJwtPayload;
  if (!claims?.access?.admin) {
    throw new Error('Admin caller required');
  }
}

export class NebulaClientTest extends NebulaClient {
  // --- Result storage for test assertions ---
  lastResult: any = undefined;
  lastError: string | undefined = undefined;
  callCompleted = false;
  lastEchoMessage: string | undefined = undefined;
  lastAdminEchoMessage: string | undefined = undefined;

  // Handler for call results (no @mesh needed — local chain executor)
  handleResult(value: any): void {
    if (value instanceof Error) {
      this.lastError = value.message;
      this.lastResult = undefined;
    } else {
      this.lastResult = value;
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  resetResults(): void {
    this.lastResult = undefined;
    this.lastError = undefined;
    this.callCompleted = false;
  }

  // --- Mesh-callable methods (DOs call these through the Gateway) ---

  @mesh()
  echo(message: string): string {
    this.lastEchoMessage = message;
    return `Client echoed: ${message}`;
  }

  @mesh(requireAdminCaller)
  adminEcho(message: string): string {
    this.lastAdminEchoMessage = message;
    return `Admin client echoed: ${message}`;
  }

  // --- Test initiators (tests call these to trigger outbound mesh calls) ---
  // Uses this.lmz.call() with this.ctn<TargetType>().method(args) continuation pattern

  callStarWhoAmI(starInstanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().whoAmI();
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  callStarGetConfig(starInstanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().getStarConfig();
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  callStarSetConfig(starInstanceName: string, key: string, value: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().setStarConfig(key, value);
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  callResourceHistoryGetHistory(instanceName: string): void {
    this.resetResults();
    const remote = this.ctn<ResourceHistory>().getHistory();
    this.lmz.call('RESOURCE_HISTORY', instanceName, remote, this.ctn().handleResult(remote));
  }

  callUniverseGetConfig(instanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Universe>().getUniverseConfig();
    this.lmz.call('UNIVERSE', instanceName, remote, this.ctn().handleResult(remote));
  }

  callUniverseSetConfig(instanceName: string, key: string, value: string): void {
    this.resetResults();
    const remote = this.ctn<Universe>().setUniverseConfig(key, value);
    this.lmz.call('UNIVERSE', instanceName, remote, this.ctn().handleResult(remote));
  }

  callGalaxyGetConfig(instanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().getGalaxyConfig();
    this.lmz.call('GALAXY', instanceName, remote, this.ctn().handleResult(remote));
  }

  callGalaxySetConfig(instanceName: string, key: string, value: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().setGalaxyConfig(key, value);
    this.lmz.call('GALAXY', instanceName, remote, this.ctn().handleResult(remote));
  }

  // --- DagTree test initiators ---

  callStarDagTreeGetState(starName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getState();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarCreateNode(starName: string, parentId: number, slug: string, label: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().createNode(parentId, slug, label);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarAddEdge(starName: string, parentId: number, childId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().addEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRemoveEdge(starName: string, parentId: number, childId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().removeEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarReparentNode(starName: string, childId: number, oldParentId: number, newParentId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().reparentNode(childId, oldParentId, newParentId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarDeleteNode(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().deleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarUndeleteNode(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().undeleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRenameNode(starName: string, nodeId: number, newSlug: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().renameNode(nodeId, newSlug);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRelabelNode(starName: string, nodeId: number, newLabel: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().relabelNode(nodeId, newLabel);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarSetPermission(starName: string, nodeId: number, targetSub: string, level: PermissionTier): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().setPermission(nodeId, targetSub, level);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRevokePermission(starName: string, nodeId: number, targetSub: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().revokePermission(nodeId, targetSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarCheckPermission(starName: string, nodeId: number, tier: PermissionTier, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().dagTree().checkPermission(nodeId, tier, targetSub)
      : this.ctn<Star>().dagTree().checkPermission(nodeId, tier);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetEffectivePermission(starName: string, nodeId: number, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().dagTree().getEffectivePermission(nodeId, targetSub)
      : this.ctn<Star>().dagTree().getEffectivePermission(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeAncestors(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getNodeAncestors(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeDescendants(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getNodeDescendants(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }
}
