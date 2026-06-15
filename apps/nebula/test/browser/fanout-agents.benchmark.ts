/**
 * Fanout scaling benchmark — Cloudflare Agents comparison side.
 *
 * Sibling to `fanout.benchmark.ts` (Lumenize Gateway-1:1). Same N-ramp
 * shape, same payload-equivalent size, same measurement strategy — the
 * difference is the pattern under test:
 *
 *   - Naive same-DO broadcast via partyserver's
 *     `for (conn of getConnections()) conn.send(msg)` loop, triggered by
 *     `AgentClient.setState(...)` on the originator. State persistence and
 *     WebSocket connections both live on the same `BenchAgent` DO.
 *
 * Per-state-update arrivals are captured by `AgentsHarnessClient` via the
 * `onStateUpdate` callback, keyed by `state.benchETag` (a UUID the originator
 * pre-generates per "commit").
 *
 * The Agent class is bound at `env.BenchAgent`. URL routing via
 * `routeAgentRequest` in the bench worker's fetch handler: clients connect
 * to `/agents/bench-agent/<instance-name>`. All N+1 clients connect to the
 * SAME instance name so they share one BenchAgent DO.
 *
 * See `tasks/fanout-scaling-benchmark.md` for the full plan.
 */

import { describe, it, expect, inject } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentsHarnessClient } from './agents-harness-client';

const RAMP_N_VALUES = (process.env.FANOUT_N_VALUES ?? '10,50,100')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

const RAMP_COMMITS_PER_N = parseInt(process.env.FANOUT_COMMITS_PER_N ?? '5', 10);
const FANOUT_TIMEOUT_MS = parseInt(process.env.FANOUT_TIMEOUT_MS ?? '30000', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.FANOUT_TEST_TIMEOUT_MS ?? '600000', 10);
const WS_CONNECT_TIMEOUT_MS = parseInt(process.env.FANOUT_WS_TIMEOUT_MS ?? '60000', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Stats {
  mean: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function statsOf(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    mean: sorted.length === 0 ? NaN : sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

interface CommitMeasurement {
  commitIndex: number;
  benchETag: string;
  tBeforeTrigger: number;
  tAfterTrigger: number;
  arrivals: Array<{ subscriberIndex: number; tArrived: number }>;
  missing: number[];
}

interface RampStepResult {
  N: number;
  instanceName: string;
  commits: CommitMeasurement[];
}

async function runRampStep(args: {
  N: number;
  originator: AgentsHarnessClient;
  subscribers: AgentsHarnessClient[];
  count: number;
}): Promise<RampStepResult> {
  const { N, originator, subscribers } = args;
  if (subscribers.length !== N) {
    throw new Error(`runRampStep: expected ${N} subscribers, got ${subscribers.length}`);
  }
  for (const sub of subscribers) sub.resetArrivals();

  const commits: CommitMeasurement[] = [];
  let runningCount = args.count;
  for (let c = 0; c < RAMP_COMMITS_PER_N; c++) {
    const benchETag = crypto.randomUUID();
    runningCount += 1;
    const tBeforeTrigger = performance.now();
    originator.triggerStateUpdate({ benchETag, count: runningCount });
    const tAfterTrigger = performance.now();

    const arrivals: Array<{ subscriberIndex: number; tArrived: number }> = [];
    const missing: number[] = [];
    await Promise.all(
      subscribers.map(async (sub, idx) => {
        try {
          const tArrived = await sub.waitForArrival(benchETag, FANOUT_TIMEOUT_MS);
          arrivals.push({ subscriberIndex: idx, tArrived });
        } catch {
          missing.push(idx);
        }
      }),
    );

    commits.push({ commitIndex: c, benchETag, tBeforeTrigger, tAfterTrigger, arrivals, missing });
    for (const sub of subscribers) sub.resetArrivals();
  }

  return { N, instanceName: 'shared', commits };
}

function summarizeRampStep(step: RampStepResult): {
  N: number;
  commits: number;
  errors: number;
  span: Stats;
  perSubscriberLatency: Stats;
  endToEnd: Stats;
} {
  const spans: number[] = [];
  const perSubscriber: number[] = [];
  const endToEnd: number[] = [];
  let errors = 0;
  for (const commit of step.commits) {
    errors += commit.missing.length;
    if (commit.arrivals.length === 0) continue;
    const times = commit.arrivals.map((a) => a.tArrived);
    const min = Math.min(...times);
    const max = Math.max(...times);
    spans.push(max - min);
    for (const a of commit.arrivals) {
      perSubscriber.push(a.tArrived - commit.tAfterTrigger);
      endToEnd.push(a.tArrived - commit.tBeforeTrigger);
    }
  }
  return {
    N: step.N,
    commits: step.commits.length,
    errors,
    span: statsOf(spans),
    perSubscriberLatency: statsOf(perSubscriber),
    endToEnd: statsOf(endToEnd),
  };
}

describe('fanout latency — Phase 3 (N-subscriber ramp, Cloudflare Agents)', () => {
  it('measures fanout shape across N values via Agents setState broadcast', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';
    const instanceName = `bench-${crypto.randomUUID().slice(0, 8)}`;

    const N_MAX = Math.max(...RAMP_N_VALUES);
    const M_MAX = N_MAX + 1;

    console.log(
      `[fanout-agents-bench] ${label} — ${baseUrl} — instance ${instanceName} — N values [${RAMP_N_VALUES.join(',')}] — pre-creating ${M_MAX} AgentClients`,
    );

    const clients: AgentsHarnessClient[] = [];
    for (let i = 0; i < M_MAX; i++) {
      clients.push(new AgentsHarnessClient({ baseUrl, instanceName }));
    }

    try {
      const wsStart = Date.now();
      await Promise.all(
        clients.map(async (client, idx) => {
          while (!client.connected) {
            if (Date.now() - wsStart > WS_CONNECT_TIMEOUT_MS) {
              throw new Error(`AgentClient ${idx} did not connect within ${WS_CONNECT_TIMEOUT_MS}ms`);
            }
            await new Promise((r) => globalThis.setTimeout(r, 25));
          }
        }),
      );
      console.log(`[fanout-agents-bench] all ${M_MAX} AgentClients connected in ${Date.now() - wsStart}ms`);

      // Warmup: one trigger so the Agent's setState path is hot before measurement.
      clients[0].triggerStateUpdate({ benchETag: crypto.randomUUID(), count: 0 });
      // Give the broadcast a beat to propagate. Not measured.
      await new Promise((r) => globalThis.setTimeout(r, 250));
      for (const c of clients) c.resetArrivals();

      const stepResults: RampStepResult[] = [];
      const summaries: ReturnType<typeof summarizeRampStep>[] = [];
      const sortedN = [...RAMP_N_VALUES].sort((a, b) => a - b);
      let totalCommits = 0;
      for (const N of sortedN) {
        console.log(`[fanout-agents-bench] N=${N} — ${RAMP_COMMITS_PER_N} commits`);
        const stepStart = Date.now();
        const step = await runRampStep({
          N,
          originator: clients[0],
          subscribers: clients.slice(1, N + 1),
          count: totalCommits,
        });
        totalCommits += RAMP_COMMITS_PER_N;
        const summary = summarizeRampStep(step);
        stepResults.push(step);
        summaries.push(summary);
        console.log(
          `[fanout-agents-bench] N=${N} done in ${Date.now() - stepStart}ms — ` +
          `span p50=${fmt(summary.span.p50)} p99=${fmt(summary.span.p99)} ms — ` +
          `per-sub p50=${fmt(summary.perSubscriberLatency.p50)} p99=${fmt(summary.perSubscriberLatency.p99)} ms — ` +
          `errors=${summary.errors}`,
        );
      }

      console.log('\n==================== fanout-agents-bench results ====================');
      console.log(`${'N'.padStart(6)} | ${'commits'.padStart(7)} | ${'errors'.padStart(6)} | ` +
        `${'e2e p50'.padStart(9)} | ${'e2e p99'.padStart(9)} | ${'e2e max'.padStart(9)}`);
      for (const s of summaries) {
        console.log(
          `${String(s.N).padStart(6)} | ${String(s.commits).padStart(7)} | ${String(s.errors).padStart(6)} | ` +
          `${fmt(s.endToEnd.p50).padStart(9)} | ${fmt(s.endToEnd.p99).padStart(9)} | ${fmt(s.endToEnd.max).padStart(9)}`,
        );
      }
      console.log('======================================================================\n');

      const rawPath = path.join(__dirname, `fanout-agents-raw-${label}.json`);
      fs.writeFileSync(rawPath, JSON.stringify({ label, baseUrl, instanceName, summaries, stepResults }, null, 2));
      console.log(`[fanout-agents-bench] raw → ${rawPath}`);

      const headerRow = '| N | commits | errors | e2e p50 (ms) | e2e p99 (ms) | e2e max (ms) |';
      const sepRow = '| ---: | ---: | ---: | ---: | ---: | ---: |';
      const rows = summaries.map((s) =>
        `| ${s.N} | ${s.commits} | ${s.errors} | ${fmt(s.endToEnd.p50)} | ${fmt(s.endToEnd.p99)} | ${fmt(s.endToEnd.max)} |`,
      );
      const lines = [
        `# Fanout Bench — Cloudflare Agents naive-broadcast (${label})`,
        ``,
        `- **baseUrl**: \`${baseUrl}\``,
        `- **agent class**: \`BenchAgent\` (extends \`agents/Agent\`, naive partyserver \`broadcast\` loop)`,
        `- **instance**: \`${instanceName}\` (all M=${M_MAX} clients share one DO)`,
        `- **N values**: ${RAMP_N_VALUES.join(', ')}`,
        `- **commits per N**: ${RAMP_COMMITS_PER_N}`,
        `- **bench source**: [fanout-agents.benchmark.ts](fanout-agents.benchmark.ts) · [agents-harness-client.ts](agents-harness-client.ts)`,
        ``,
        `## Latency vs N`,
        ``,
        headerRow,
        sepRow,
        ...rows,
        ``,
        `\`e2e\` = \`t_arrived − t_before_trigger\` per subscriber per commit — wall-clock from "originator called \`setState\`" to "subscriber's \`onStateUpdate\` fired." \`p50\` is the median subscriber's wait; \`p99\` is the 99th-percentile subscriber's wait; \`max\` is the worst observed subscriber across all commits at this N.`,
        ``,
        `\`errors > 0\` means at least one subscriber didn't receive the state update within \`FANOUT_TIMEOUT_MS\`.`,
        ``,
        `Raw per-subscriber arrival data + full Stats (mean, p50, p75, p95, p99, min, max) for span / per-subscriber-latency / end-to-end are in [fanout-agents-raw-${label}.json](fanout-agents-raw-${label}.json).`,
        ``,
      ];
      const summaryPath = path.join(__dirname, `RESULTS-fanout-agents-${label}.md`);
      fs.writeFileSync(summaryPath, lines.join('\n'));
      console.log(`[fanout-agents-bench] summary → ${summaryPath}`);

      expect(stepResults.length).toBe(RAMP_N_VALUES.length);
      for (const s of summaries) {
        expect(s.commits).toBe(RAMP_COMMITS_PER_N);
      }
    } finally {
      for (const c of clients) c.close();
    }
  }, TEST_TIMEOUT_MS);
});
