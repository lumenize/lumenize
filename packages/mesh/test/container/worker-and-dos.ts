import { Container } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import {
  newContinuation,
  executeOperationChain,
  type OperationChain,
  type Continuation,
} from '../../src/ocan/index.js';
import { createLmzApiForDO, executeEnvelope, type LmzApi, type CallEnvelope } from '../../src/lmz-api.js';
import { mesh } from '../../src/mesh-decorator.js';

/**
 * Bare `extends Container` probe for the Phase-2 feasibility precheck.
 *
 * The base `Container` constructor throws if `ctx.container === undefined`
 * (`@cloudflare/containers@0.3.7` container.js:350), which vitest-pool-workers
 * only populates when it actually provisions a container engine. This probe
 * answers: does a `class X extends Container {}` construct at all under
 * pool-workers? (Resolved: NO — see precheck.test.ts.)
 */
export class ProbeContainer extends Container {
  defaultPort = 5173;
  ping(): string {
    return 'pong';
  }
}

/** Custom Error carrying an own property, for the error-round-trip test (m9). */
export class SeamCustomError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SeamCustomError';
    this.code = code;
  }
}

/**
 * `MeshContainerSeamHarness` — a non-`Container` DO that composes the EXACT same
 * comms+guards receive contract as `LumenizeContainer` (the precheck proved the
 * assembled `extends Container` form can't be constructed under pool-workers, so
 * the seam is verified here against a `DurableObject` base instead). Every mesh
 * member below is a verbatim mirror of `LumenizeContainer`'s recipe — same shared
 * building blocks (`createLmzApiForDO` / `executeEnvelope` / `executeOperationChain`),
 * never reimplemented. The literal `LumenizeContainer` prototype wiring + fetch
 * pin are locked separately by container-prototype.test.ts (pure, no construction).
 */
export class MeshContainerSeamHarness extends DurableObject<Env> {
  #lmzApi: LmzApi | null = null;

  get lmz(): LmzApi {
    if (!this.#lmzApi) {
      this.#lmzApi = createLmzApiForDO(this.ctx, this.env, this);
    }
    return this.#lmzApi;
  }

  ctn(): Continuation<this>;
  ctn<T>(): Continuation<T>;
  ctn(): Continuation<unknown> {
    return newContinuation() as Continuation<unknown>;
  }

  onBeforeCall(): void {
    // Marker for the m8 mutation-check: comment out `node.onBeforeCall()` in
    // executeEnvelope (lmz-api.ts) → the marker-count assertion goes RED.
    debug('lmz.mesh.test.SeamHarness.onBeforeCall').debug('entry', {
      instanceName: this.lmz.instanceName,
    });
  }

  async __executeChain(chain: OperationChain): Promise<any> {
    return await executeOperationChain(chain, this);
  }

  get __localChainExecutor(): (chain: OperationChain, options?: { requireMeshDecorator?: boolean }) => Promise<any> {
    return (chain, options) => executeOperationChain(chain, this, options);
  }

  async __executeOperation(envelope: CallEnvelope): Promise<any> {
    return await executeEnvelope(envelope, this, {
      nodeTypeName: 'LumenizeContainer',
      includeInstanceName: true,
    });
  }

  // ---- @mesh surface exercised by the seam/guard tests ----

  /** M4: an inbound mesh call lands here and returns a value. */
  @mesh()
  echo(value: string): string {
    return `seam:${value}`;
  }

  /** Not mesh-callable — a mesh call to this must be rejected (@mesh enforcement). */
  plainMethod(): string {
    return 'should-not-be-callable';
  }

  /** m9: throws a custom Error to exercise the {$error} structured-clone round-trip. */
  @mesh()
  boom(): never {
    throw new SeamCustomError('kaboom from container node', 'SEAM_X');
  }

  /** M4 outgoing: after identity is stamped, fire an outgoing mesh call to a sibling. */
  @mesh()
  pingOther(otherInstance: string, marker: string): void {
    this.lmz.call('SEAM_HARNESS', otherInstance, this.ctn().recordPing(marker));
  }

  /** Outgoing-call target (sibling harness). */
  @mesh()
  recordPing(marker: string): void {
    this.ctx.storage.kv.put('last_ping', marker);
  }

  /** Read back what recordPing stored (direct RPC test helper). */
  getLastPing(): string | undefined {
    return this.ctx.storage.kv.get('last_ping') as string | undefined;
  }

  /** Read this node's stamped identity (direct RPC test helper). */
  getStampedIdentity(): { bindingName?: string; instanceName?: string } {
    return { bindingName: this.lmz.bindingName, instanceName: this.lmz.instanceName };
  }

  /**
   * Negative micro-check: invoked via DIRECT RPC (not through executeEnvelope),
   * so identity is never stamped → `bindingName` is unset → the outgoing
   * `lmz.call` must throw the "doesn't know its binding name" error. Makes the
   * "outgoing needs a prior inbound" ordering explicit + capable-of-failing.
   */
  tryOutgoingWithoutInit(): void {
    this.lmz.call('SEAM_HARNESS', 'anyone', this.ctn().recordPing('nope'));
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('precheck');
  },
};
