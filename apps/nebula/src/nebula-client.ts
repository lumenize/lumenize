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
}
