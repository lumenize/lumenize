import { LumenizeContainer } from '@lumenize/mesh/container';
import { mesh } from '@lumenize/mesh';
import { preprocess } from '@lumenize/structured-clone';

/**
 * Phase-0 kill-fast smoke for the 4th node type. A real `LumenizeContainer`-based
 * node deployed to live infra, to answer (per tasks/nebula-container-dev-loop.md
 * Phase 0):
 *  1. Does `extends Container` + the composed mesh core CONSTRUCT on real infra
 *     (ctx.container populated — the thing pool-workers can't do)?
 *  2. Does the composed Lumenize identity COEXIST with `Container`'s own
 *     lifecycle (the `container_schedules` table + the alarm slot its ctor sets)?
 *  3. Does an inbound mesh call land via `__executeOperation` (the `@mesh`
 *     receive path) — which also exercises whether `wrangler deploy` can bundle
 *     the `@mesh` TC39 decorator (the bundle question this Worker's dry-run answers).
 */
export class SmokeContainer extends LumenizeContainer {
  defaultPort = 8080;

  /** @mesh receive-path probe — returns this node's composed identity. */
  @mesh()
  ping(): string {
    return `pong from ${this.lmz.instanceName ?? '(no instance name)'}`;
  }

  /**
   * Direct-RPC probe (no @mesh): after the ping envelope stamped identity, report
   * Container's own lifecycle state coexisting with the composed Lumenize identity.
   */
  async coexistence(): Promise<{
    type: string;
    bindingName?: string;
    instanceName?: string;
    hasContainerSchedulesTable: boolean;
    hasAlarm: boolean;
  }> {
    const row = this.ctx.storage.sql
      .exec(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='container_schedules'`)
      .one() as { c: number };
    const alarm = await this.ctx.storage.getAlarm();
    return {
      type: this.lmz.type,
      bindingName: this.ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined,
      instanceName: this.ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined,
      hasContainerSchedulesTable: row.c > 0,
      hasAlarm: alarm !== null,
    };
  }
}

export default {
  async fetch(_request: Request, env: { SMOKE: DurableObjectNamespace }): Promise<Response> {
    const instanceName = 'phase0-smoke';
    const stub = (env.SMOKE as any).getByName(instanceName);

    // Drive one inbound mesh call through the REAL receive seam (executeEnvelope
    // → onBeforeCall → __executeChain → ping), stamping identity from metadata.callee.
    const chain = [
      { type: 'get', key: 'ping' },
      { type: 'apply', args: [] },
    ];
    const envelope = {
      version: 1,
      chain: preprocess(chain),
      callContext: { callChain: [], state: {} },
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'SMOKE', instanceName } },
    };

    let meshResult: unknown;
    let constructError: string | undefined;
    try {
      meshResult = await stub.__executeOperation(envelope);
    } catch (e) {
      constructError = e instanceof Error ? e.message : String(e);
    }

    const coexistence = constructError ? null : await stub.coexistence();

    return Response.json(
      { constructed: !constructError, constructError, meshResult, coexistence },
      { status: constructError ? 500 : 200 },
    );
  },
};
