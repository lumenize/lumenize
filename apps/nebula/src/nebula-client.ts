/**
 * NebulaClient — extends LumenizeClient with the two-scope model
 *
 * Auth scope: determines the refresh cookie path (e.g., 'acme.app.tenant-a' or 'acme')
 * Active scope: baked into the JWT's aud claim (e.g., 'acme.app.tenant-a')
 */

// Imports use the Node-safe /client subpath so this file can be imported
// from Node test harnesses (e.g. apps/nebula/test/browser/) — the main
// `@lumenize/mesh` entry pulls in `cloudflare:workers` via LumenizeDO and
// fails outside Workers. The same applies to types: import only from
// /client to keep this module Node-importable in full.
import { LumenizeClient, mesh } from '@lumenize/mesh/client';
import type { LumenizeClientConfig } from '@lumenize/mesh/client';
import type { TransactionResult, Snapshot } from './resources';

export interface NebulaClientConfig extends Omit<LumenizeClientConfig, 'refresh' | 'gatewayBindingName'> {
  /** Auth scope — determines refresh cookie path (e.g., 'acme.app.tenant-a' or 'acme' for admins) */
  authScope: string;
  /** Active scope — baked into JWT aud claim (e.g., 'acme.app.tenant-a') */
  activeScope: string;
}

export class NebulaClient extends LumenizeClient {
  #authScope: string;
  #activeScope: string;

  constructor(config: NebulaClientConfig) {
    const { authScope, activeScope, ...baseConfig } = config;

    super({
      ...baseConfig,
      gatewayBindingName: 'NEBULA_CLIENT_GATEWAY',
      refresh: async () => {
        const fetchFn = config.fetch ?? fetch;
        const res = await fetchFn(
          `${config.baseUrl}/auth/${authScope}/refresh-token`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeScope }),
          },
        );
        if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
        const data = await res.json() as { access_token: string; sub: string };
        return { access_token: data.access_token, sub: data.sub };
      },
    });

    this.#authScope = authScope;
    this.#activeScope = activeScope;
  }

  /** Receive transaction result from Star — Phase 5.3 will add real implementation */
  @mesh()
  handleTransactionResult(_result: TransactionResult | Error): void {
    console.warn('handleTransactionResult not yet implemented — see Phase 5.3');
  }

  /** Receive read result from Star — Phase 5.3 will add real implementation */
  @mesh()
  handleReadResult(_result: Snapshot | null | Error): void {
    console.warn('handleReadResult not yet implemented — see Phase 5.3');
  }

  /**
   * Receive resource snapshot push from Star — initial value after subscribe,
   * ongoing fanout after mutations (Phase 5.3.2), or an Error if subscribe
   * itself failed (resource not found / permission denied / ontology mismatch).
   *
   * Stub until Phase 5.3.3 — real implementation writes through to bound state.
   */
  @mesh()
  handleResourceUpdate(_resourceType: string, _resourceId: string, _result: Snapshot | null | Error): void {
    console.warn('handleResourceUpdate not yet implemented — see Phase 5.3');
  }

  /**
   * Accept calls relayed through Star (fanout, transaction-result, read-result).
   *
   * The default `LumenizeClient.onBeforeCall` rejects calls where `callChain[0]`
   * is another `LumenizeClient` instance (its peer-to-peer guard). Nebula's
   * fanout pattern is **Star-mediated**, not peer-to-peer: client A mutates →
   * Star fans out → client B receives `handleResourceUpdate`. The default's
   * `callChain[0] === otherClient` view of this is too strict.
   *
   * The actual security boundary is `NebulaClientGateway.onBeforeCallToClient`,
   * which verifies the call's `originAuth.claims.aud` matches the connected
   * client's aud at the Gateway. Once a call has cleared that check, it has
   * a legitimate Nebula-scope and can be dispatched on the client.
   */
  override onBeforeCall(): void {
    // intentionally permissive — Gateway aud check is the boundary
  }
}
