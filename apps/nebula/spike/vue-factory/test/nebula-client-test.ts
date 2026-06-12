/**
 * Test subclass of the spike's NebulaClient. Adds `@mesh()` handlers and
 * `lmz.call` initiator methods needed for test setup (ontology version
 * append, resource create). Mirrors the pattern from
 * `apps/nebula/test/test-apps/baseline/index.ts:NebulaClientTest`.
 */
import { mesh } from '@lumenize/mesh/client';
import type {
  Galaxy,
  Star,
  TransactionResult,
  OntologyVersionConfig,
  OperationDescriptor,
  Snapshot,
} from '@lumenize/nebula';
import { NebulaClient } from '../src/nebula-client';

export class NebulaClientTest extends NebulaClient {
  // Result capture
  lastResult: any = undefined;
  lastError: string | undefined = undefined;
  callCompleted = false;

  resetResults(): void {
    this.lastResult = undefined;
    this.lastError = undefined;
    this.callCompleted = false;
  }

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

  // Test initiator: append ontology version (admin scope required)
  callGalaxyAppendOntologyVersion(galaxyName: string, versionConfig: OntologyVersionConfig): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().appendOntologyVersion(versionConfig);
    this.lmz.call('GALAXY', galaxyName, remote, this.ctn().handleResult(remote));
  }

  // Test initiator: create resource directly via Star.transaction
  callStarTransaction(
    starName: string,
    ontologyVersion: string,
    ops: Record<string, OperationDescriptor>,
    newETag?: string,
  ): void {
    this.resetResults();
    const txnETag = newETag ?? crypto.randomUUID();
    this.lmz.call('STAR', starName,
      this.ctn<Star>().transaction(ontologyVersion, txnETag, ops));
  }

  // Override the transaction-result mesh handler to:
  //   1. Delegate to base for the in-flight queue settlement (so
  //      client.resources.transaction() Promises resolve correctly).
  //   2. Capture into lastResult/lastError for legacy callStarTransaction users.
  @mesh()
  override handleTransactionResult(result: TransactionResult | Error): void {
    super.handleTransactionResult(result);
    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastResult = undefined;
    } else {
      this.lastResult = result;
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  // Override resource update for tests that want to observe pushes directly.
  // Still delegates to base so the factory's registered handler fires too.
  lastResourceUpdate: { resourceType: string; resourceId: string; snapshot: Snapshot | null } | undefined = undefined;
  resourceUpdateCount = 0;

  @mesh()
  override handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | null | Error): void {
    super.handleResourceUpdate(resourceType, resourceId, result);
    this.resourceUpdateCount++;
    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastResourceUpdate = undefined;
    } else {
      this.lastResourceUpdate = { resourceType, resourceId, snapshot: result };
    }
  }
}
