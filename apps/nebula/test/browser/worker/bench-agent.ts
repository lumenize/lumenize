/**
 * BenchAgent — minimal Cloudflare Agents subclass used by the fanout-scaling
 * benchmark (`tasks/fanout-scaling-benchmark.md`) to compare the naive same-DO
 * broadcast pattern (state DO holds WebSockets, push via tight loop) against
 * the Lumenize Gateway-1:1 pattern.
 *
 * State payload is intentionally minimal — `benchETag` is a UUID the
 * originator chooses per commit so subscribers can correlate which trigger
 * each broadcast corresponds to. `count` exists so subsequent updates aren't
 * deduped as no-ops.
 *
 * No `onMessage` override needed: `AgentClient.setState(...)` on any
 * connected client sends the state-update message to the Agent, which calls
 * the framework's `_setStateInternal` and broadcasts a `cf_agent_state` frame
 * to all *other* connections via partyserver's
 * `for (conn of getConnections()) conn.send(msg)` loop. That loop is the
 * naive pattern under test.
 */

import { Agent } from 'agents';

export interface BenchAgentState {
  benchETag: string;
  count: number;
  /** Optional padding so we can compare payload-size effects later. */
  padding?: string;
}

export class BenchAgent extends Agent<Env, BenchAgentState> {
  initialState: BenchAgentState = { benchETag: '', count: 0 };
}
