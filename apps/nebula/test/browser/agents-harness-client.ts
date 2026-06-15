/**
 * AgentsHarnessClient — `AgentClient` wrapper that captures per-state-update
 * arrival times keyed by `state.benchETag`, used by the fanout-scaling
 * benchmark's Cloudflare Agents comparison side.
 *
 * Mirrors `HarnessNebulaClient.waitForFanoutArrival(eTag)` semantics — the
 * originator pre-generates a UUID per "commit" via
 * `crypto.randomUUID()`, calls `setState({ benchETag, count })`, and each
 * subscriber's `onStateUpdate` callback fires (source === 'server'). The
 * harness records `performance.now()` keyed by `benchETag`.
 *
 * The `agents` package's `AgentClient` extends `PartySocket`. We use
 * `host`-based construction so the test can target wrangler dev's local
 * URL or the deployed worker via `BENCH_BASE_URL`.
 */

import { AgentClient } from 'agents/client';
import type { BenchAgentState } from './worker/bench-agent';

export interface AgentsHarnessClientOptions {
  /** Worker URL (e.g. `https://127.0.0.1:8787` or `https://nebula-browser-test...`). */
  baseUrl: string;
  /** Agent instance name — all bench clients connect to the same instance. */
  instanceName: string;
}

export class AgentsHarnessClient {
  readonly client: AgentClient<unknown, BenchAgentState>;
  /** Map<benchETag, t_arrived ms> — captured by onStateUpdate. */
  #arrivalsByETag = new Map<string, number>();
  /** Resolvers registered by `waitForArrival` for eTags not yet seen. */
  #pendingWaits = new Map<string, (t: number) => void>();
  /** True once the WS has opened. Used by the test to await readiness. */
  #connected = false;

  constructor(opts: AgentsHarnessClientOptions) {
    // PartySocket expects `host` without scheme. AgentClient internally
    // upgrades http(s)→ws(s). Override the protocol-from-host heuristic that
    // forces `ws://` for any `127.0.0.1:` host — wrangler dev runs HTTPS, so
    // we need `wss://`. Derive from the URL scheme.
    const url = new URL(opts.baseUrl);
    const host = url.host;
    const protocol: 'ws' | 'wss' = url.protocol === 'https:' ? 'wss' : 'ws';
    // `prefix: 'agents'` is the default for AgentClient — `routeAgentRequest`
    // on the server uses the same prefix.
    this.client = new AgentClient<unknown, BenchAgentState>({
      host,
      protocol,
      agent: 'bench-agent',
      name: opts.instanceName,
      // PartySocket accepts a `WebSocket` constructor injection — let the
      // default global `WebSocket` (Node 22 has it built-in) be used.
      onStateUpdate: (state: BenchAgentState, source: 'server' | 'client') => {
        if (source !== 'server') return;
        if (typeof state?.benchETag !== 'string' || state.benchETag === '') return;
        const t = performance.now();
        this.#arrivalsByETag.set(state.benchETag, t);
        const waiter = this.#pendingWaits.get(state.benchETag);
        if (waiter) {
          this.#pendingWaits.delete(state.benchETag);
          waiter(t);
        }
      },
    });

    this.client.addEventListener('open', () => { this.#connected = true; });
    this.client.addEventListener('close', (ev: any) => {
      this.#connected = false;
      if (process.env.FANOUT_DEBUG === '1') {
        console.log(`[agents-harness] WS closed code=${ev?.code} reason=${ev?.reason} clean=${ev?.wasClean}`);
      }
    });
    this.client.addEventListener('error', (ev: any) => {
      if (process.env.FANOUT_DEBUG === '1') {
        console.log(`[agents-harness] WS error message=${ev?.message ?? ev?.error?.message} type=${ev?.type}`);
      }
    });
  }

  get connected(): boolean {
    return this.#connected;
  }

  /**
   * Send a state update from this client. The Agent server receives the
   * message, persists state, and broadcasts a `cf_agent_state` frame to all
   * *other* connected clients. The sender's own `onStateUpdate` fires with
   * source `'client'` — we ignore that path so the originator doesn't show
   * up as a self-arrival.
   */
  triggerStateUpdate(state: BenchAgentState): void {
    this.client.setState(state);
  }

  /**
   * Wait for this client's onStateUpdate to fire for `benchETag`. Resolves
   * with the captured `performance.now()` timestamp.
   */
  waitForArrival(benchETag: string, timeoutMs = 30_000): Promise<number> {
    const cached = this.#arrivalsByETag.get(benchETag);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise<number>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.#pendingWaits.delete(benchETag);
        reject(new Error(`AgentsHarnessClient.waitForArrival: timeout after ${timeoutMs}ms for benchETag ${benchETag}`));
      }, timeoutMs);
      this.#pendingWaits.set(benchETag, (t) => {
        globalThis.clearTimeout(timer);
        resolve(t);
      });
    });
  }

  resetArrivals(): void {
    this.#arrivalsByETag.clear();
  }

  close(): void {
    try {
      this.client.close();
    } catch {
      // Best-effort close
    }
  }
}
