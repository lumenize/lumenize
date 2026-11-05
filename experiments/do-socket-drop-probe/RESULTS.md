# do-socket-drop-probe: why a hosting Durable Object dropped every socket (deployed)

**Question.** `experiments/gateway-vs-hosted` found two things it could not explain. A JS loop cost
3–4 ms per call on some object instances and about 30 ms on others. And in the slow state, the
object holding its clients' sockets closed all of them within seconds, while the same object
behind Gateways lost almost nothing. This experiment finds out which of three things drops the
sockets (the object, the runtime closing sockets, or a CPU limit) and what triggers it.

**Method.** `experiment-do-socket-drop-probe`, deployed 2026-10-04, driven from one Node process
in Pittsburgh. `ProbeDO` (`src/index.ts`) is a raw Durable Object with no mesh, reachable over
its own hibernatable WebSockets or over Workers RPC through the Worker. Each call burns CPU one of
three ways in one synchronous event:

- **`js`** is the `Math.imul` loop from gateway-vs-hosted's `heavy`, whose speed depends on V8's
  optimizing compiler.
- **`sql`** is a SQLite recursive CTE counting to `n`, native code with no JIT.
- **`json`** is `JSON.parse` of a ~100 KB string, V8's C++ parser with no JIT.

The object keeps its own evidence. It counts its constructions in storage (`boots`), returns a
random `bootId` per construction on every reply, and logs every server-side `webSocketClose` and
`webSocketError`. The driver (`scripts/probe.mjs`) records every close code it sees and every
`bootId`.

## Result

**The runtime resets the object, and the socket closes are a consequence.** Every drop was code
1006 on the client, the object's boot count went up by one, and the object logged no
`webSocketClose` or `webSocketError` first: it never saw its sockets close, because it was gone.
The rebuilt object ran fast every time we could tell.

### Some instances run hot JavaScript about 10× slower, and only JavaScript

Sixteen fresh instances, each burn sized to about 3 ms on a fast instance (`jit` mode):

| | `js`, per 2M iterations | `sql` | `json` |
|---|---|---|---|
| 10 fast instances | 6.4 ms or less | 2.3–5.3 ms | 2.3–4.6 ms |
| 6 slow instances | 26.6–54.4 ms | 2.6–5.3 ms | 2.8–5.3 ms |

- **The machine is not slow.** On the slow instances SQLite and `JSON.parse` ran at the same speed
  as on the fast ones; only the JS loop slowed down. A tight integer loop running about 10× slower
  is what code that never reaches V8's optimizing tier looks like. That is consistent with the
  optimizing compiler never finishing on those isolates, but this experiment does not prove it.
- **It is common, and it comes and goes.** 6 of 16 `jit` instances were slow. Hunting for a slow
  instance took 1–4 fresh instances each of 9 times, and one hunt for a fast instance took 11.
  Both colos seen, IAD and EWR, had slow instances.
- **It can end on its own.** Two RPC runs on instances measured slow a moment earlier ran at
  about twice the rate of the slow RPC run from their first second, which fits fast JS, with no
  reset.

### Sustained JavaScript in the slow state ends in a reset

One scenario per freshly hunted instance, 40–50 s each:

| instance | work | transport | reset? | when |
|---|---|---|---|---|
| slow | `js` ~30 ms, one call at a time | WebSocket ×1 | yes (×3) | 21.6 s, 49.2 s, 48.4 s |
| slow | `js` ~30 ms, one call at a time | WebSocket ×16 | yes | 13.1 s, all 16 sockets at once |
| slow | `js` ~30 ms, one call at a time | RPC | yes (×1 of 3) | 39.2 s, with no call failing |
| slow | `js`, one call every 250 ms | WebSocket ×1 | no | 50 s |
| slow | `sql` ~30 ms, one call at a time | WebSocket ×1 | no | 40 s |
| fast | `js` ~3 ms, one call at a time | WebSocket ×1 | no | 40 s |

The calibration run also reset once, within about 30 s of starting, on one socket running long `js` calls on a
slow instance.

- **The trigger is sustained JavaScript in the slow state.** The same instance running SQL just as
  hard did not reset. JavaScript spaced out to roughly 15% of a core did not reset, and fast
  instances never reset. The more of a core it used, the sooner it came: 13 s at about a full
  core, and 22–50 s at about half.
- **It is not a WebSocket behavior.** The RPC-reached object reset too. Its next call simply built
  a new object, so no caller noticed. That is why gateway-vs-hosted's Gateway arm looked immune.
- **It is not the per-request CPU limit.** gateway-vs-hosted raised `limits.cpu_ms` to its
  5-minute maximum and the resets continued.

## What this means for hosting a scope's clients

- **The cost is real but bounded.** A hosting object in this state loses every socket at once.
  Clients reconnect within moments, and the rebuilt object has so far always run fast.
- **What breaks is a call in flight.** In gateway-vs-hosted a hosted client's `callAsync` waited
  out its full 30 s timeout, because the client expects a result to follow it to the new socket.
  A Gateway outlives the reset and can still deliver one; a reset host has lost it. A hosting
  design must treat a reconnect to a new `bootId` as "every call in flight is lost" and fail them
  at once, or re-issue the idempotent ones (ADR-005's eTags).
- **The trigger is uncommon in Nebula's own work, so far as we know.** A Star's calls spend their
  time in SQLite and in structured clone and `JSON.parse`, which never triggered it. It takes tens
  of seconds of near-continuous hot JavaScript. Generated validators and the codegen loop are the
  places to watch.

## Not settled here

- **What the slow state is.** The evidence fits optimized code never arriving on that isolate,
  but nothing here observes V8's tiers directly. The pattern (common, comes and goes, JIT-only,
  ended by a reset the runtime chooses) may be worth a report to Cloudflare.
- **Whether a noisy neighbor causes it** (Larry, 2026-10-04: complaints about noisy neighbors
  have been growing on Cloudflare's Discord). One version is ruled out and one is not:
  - *A neighbor taking this object's CPU* does not fit. In gateway-vs-hosted's captured slow run,
    each event's CPU time matched its wall time (p50 30 ms CPU; wall minus CPU p50 1 ms, p90
    2 ms), so the isolate was running, not waiting for a core. SQLite and `JSON.parse` ran at
    normal speed on the same instances. And the slowed loop keeps everything in registers, so
    cache or memory-bandwidth contention cannot slow it 10×.
  - *A neighbor starving the background threads V8 compiles optimized code on* does fit
    everything here: JavaScript only, about 10×, common but intermittent, sometimes ending on
    its own, and cured by a reset that lands the object somewhere new. Telling it apart from an
    optimizer switched off for some other reason needs a different test. If load drives it, the
    share of slow instances should move with Cloudflare's load, by time of day and by colo.
- **Whether the runtime moves the object or only restarts it.** Both colos appeared before and
  after resets, but this experiment did not record the colo across a reset.
- **Real Nebula code.** Every workload here is synthetic; how often a Star or Galaxy enters the
  slow state, and how much it costs it, is unmeasured.

## Rerun

```sh
cd experiments/do-socket-drop-probe
npx wrangler deploy
openssl rand -hex 16 | tee /tmp/probe-token | npx wrangler secret put BENCH_TOKEN
export BENCH_BASE_URL=https://experiment-do-socket-drop-probe.<account>.workers.dev BENCH_TOKEN=$(cat /tmp/probe-token)
node scripts/probe.mjs calibrate          # per-call cost of each burn at several sizes
node scripts/probe.mjs jit                # fast vs slow instances, all three burns
HUNT_PLAN="ws1-js@slow,rpc1-js@slow,ws16-js@slow,ws1-js-paced@slow,ws1-sql30@slow,ws1-js@fast" \
  DURATION_S=50 node scripts/probe.mjs hunt
```

`calibrate` printed this on one instance, IAD, before its long `js` step reset it:
`sql` costs about 0.23 ms per 1,000 rows (25k → 5.7 ms, 100k → 25.2 ms, 500k → 120 ms); `json`
costs about 0.7 ms per parse; and that instance's `js` ran 500k iterations in 8.9 ms, slow. Raw
results for the other modes are in `results/`. Delete the Worker from the dashboard when done,
which also removes its Durable Object namespaces.
