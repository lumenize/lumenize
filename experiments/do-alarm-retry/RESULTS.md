# How the production alarm scheduler retries a failed `alarm()`

**Question.** A Discord user's `alarm()` catches application errors and re-arms with `setAlarm`. They asked three things: is an alarm the runtime kills mid-run (CPU or memory limit, eviction) retried like one that throws; is `alarmInfo.retryCount` right after such a retry; and is anything signalled when the six retries run out. Reading workerd's source on 2026-10-15 answered all three for the open-source half — `runAlarm` in `src/workerd/api/global-scope.c++` decides whether each failure retries and counts, and `src/workerd/server/alarm-scheduler.c++` is the local scheduler. The production scheduler that consumes that verdict is closed source, so this probe measures it.

**Setup.** `experiment-do-alarm-retry`, compatibility date 2026-10-01, `limits.cpu_ms: 1000`, Workers Logs with invocation logs and Workers Issues on. One `Probe` object per mode. Every attempt inserts `{ firedAt, scheduledTime, retryCount, isRetry }` into SQLite, then awaits `ctx.storage.sync()` and a macrotask before it fails, so the row survives a kill. `scripts/drive.mjs` arms each object 2 s out and reads its attempt log and `getAlarm()` every 5 s; `scripts/logs.mjs` reads Workers Logs afterwards. The modes:

| Mode | What the handler does after recording the attempt |
|---|---|
| `throw` | throws |
| `abort` | `ctx.abort()` |
| `abort-noretry` | `ctx.abort(reason, { retryAlarm: false })` |
| `cpu` | an infinite loop |
| `memory` | allocates 8 MB arrays until killed |
| `reset` | waits 90 s; the driver redeploys the Worker during the first two attempts |
| `cpu-catch` | burns CPU in ~50 ms chunks inside a `try`, awaiting `ctx.storage.sync()` between chunks; a `catch` logs, records and returns |
| `memory-catch` | the same, allocating 8 MB per chunk |
| `rearm-abort` | `setAlarm(now + 10 s)`, made durable, then `ctx.abort()`; stops after 6 attempts |
| `rearm-throw` | the same, then throws |

`cpu`, `memory` and `reset` ran alone, since objects of one Worker can share an isolate: a loop blocks its neighbours, a memory kill resets them, and a redeploy resets every object mid-handler.

## Results (2026-10-15, deployed)

One run per mode. The `retryCount` column is what each attempt's `alarmInfo` said; a gap is the time from one attempt's start to the next, so the `cpu` gaps include the second or three each kill took. `getAlarm()` was read after the drive's window closed.

| Mode | Attempts | `retryCount` per attempt | Gaps (s) | Outcome in Workers Logs | `getAlarm()` afterwards |
|---|---|---|---|---|---|
| `throw` | 7 | 0 1 2 3 4 5 6 | 2.1 · 4.6 · 8.4 · 18.8 · 37.7 · 72.3 | `exception` | the first attempt's time, now past |
| `abort` | 7 | 0 1 2 3 4 5 6 | 2.1 · 4.5 · 8.8 · 19.8 · 34.4 · 69.0 | `aborted` | the first attempt's time |
| `abort-noretry` | 1 | 0 | — | `aborted` | the first attempt's time |
| `cpu` | 7 | 0 1 2 3 4 5 6 | 5.8 · 8.0 · 9.8 · 20.5 · 39.3 · 76.4 | `exceededCpu` | the first attempt's time |
| `memory` | 7 | 0 1 2 3 4 5 6 | 2.7 · 5.0 · 9.8 · 18.9 · 36.9 · 74.4 | `exceededMemory` | the first attempt's time |
| `rearm-abort` | 7 | 0 every time | 10.0 × 6 | `aborted` × 6, then `ok` | `null` |
| `rearm-throw` | 7 | 0 every time | 10.0 × 6 | `exception` × 6, then `ok` | `null` |
| `reset` | 1 | 0 | — | `ok` after its full 90 s | `null` |

1. **A kill is retried exactly like a throw, and it counts.** CPU and memory kills, `ctx.abort()` and a plain throw each ran seven times: the first attempt and six retries, `retryCount` 0 through 6, `isRetry` true from the second. The backoff doubles from 2 s with up to about 25% jitter. Workers Logs records the kills as `exceededCpu` and `exceededMemory`, with the runtime's own error line, *"Durable Object exceeded its CPU time limit and was reset."* and *"Durable Object's isolate exceeded its memory limit and was reset."* `limits.cpu_ms: 1000` does reach a Durable Object's alarm, loosely: the kills landed at 1000, 2000 and 3500 ms of CPU.
2. **Nothing marks the give-up.** After the seventh attempt nothing ran, Workers Logs has no line, and Workers Issues has only one occurrence per failed attempt (`probe-throw ×7`, the CPU reset `×7`). Read again 18 minutes after the last attempt, across a cold wake of every object, no eighth attempt had run.
3. **`getAlarm()` keeps answering the dead alarm's time.** Every object whose alarm ran out, and the one aborted with `retryAlarm: false`, still answered `getAlarm()` with its first attempt's scheduled time, 18 minutes later and after a cold wake. This is where production departs from workerd's source: since April 2026 the local scheduler calls `abandonAlarm`, which clears the stored alarm so `getAlarm()` answers `null`; production does not. So a non-null `getAlarm()` does not mean an alarm is pending, and code that re-arms only when `getAlarm()` is `null` never re-arms an object whose alarm died. It is also the only trace the give-up leaves: a stored time older than the whole backoff, about two and a half minutes, with no handler running means the alarm is dead.
4. **A re-arm that is durable before the failure replaces the retry, and `retryCount` starts again at 0.** Both `rearm-*` modes ran every 10 s, the re-armed time, with `retryCount` 0 on every attempt, and the limit of six never applied: they stopped only because the probe stopped failing at its seventh attempt. The scheduler did still dispatch the old alarm's retry about 2 s after each failure. The runtime answered it `canceled` without running the handler, because a newer alarm was stored: Workers Logs shows two `canceled` alarm events with no probe line in every 10 s cycle. A handler that re-arms first and is then killed every time therefore loops forever, at the re-arm interval, with `retryCount` 0.
5. **`ctx.abort(reason, { retryAlarm: false })` ends the alarm after one attempt**, and leaves `getAlarm()` answering its time as finding 3 describes.
6. **A redeploy did not interrupt a running alarm.** The driver redeployed 20 s into the `reset` handler's 90 s wait. The stateless Worker answered from the new version within seconds, while the object stayed on the old version (`633d9ef9`) for the whole handler and for the 2.5 minutes of 5 s polls after it, to the end of the run. One trial, on an object kept busy, so this says a deploy need not reset an object mid-alarm, not that it never does.
7. **A kill also fails the requests in flight on the object.** `/report` polls that landed during a CPU spin or a memory blowout answered 500, and Workers Issues recorded each as the same reset error at `Object.fetch`.

8. **A kill cannot be caught by the code it kills, even across awaits.** The `cpu-catch` and `memory-catch` modes ran the same burn and blowout in chunks, inside a `try`, awaiting `ctx.storage.sync()` between chunks, so a condemned isolate had an I/O boundary at which to surface its reset as an exception. Over the 17 attempts the two drives watched, none recorded a catch. The second version's `catch` logs before touching storage and then returns: Workers Logs holds the probe lines of seven attempts that ran it, and no `caught` line. Every attempt ended `exceededCpu` or `exceededMemory` and was retried. This matters for the `agents` SDK (0.28.1): its alarm memory-limit circuit breaker (`#1825` in `lifecycle/job-driver.ts`) acts only on a memory-limit reset that reaches its `catch` as an Error, and its own test produces one by throwing `new Error("Durable Object's isolate exceeded its memory limit and was reset.")` from the job. A reset of the isolate running the job never reaches it. One that does would come from somewhere else, such as a call into another isolate, which this probe did not try.

**Not measured.** The 15-minute wall-time limit, which `runAlarm` counts like the kills. A retry the runtime blames on itself, which workerd counts as a broken output gate with no user error and no limit exceeded, retried with no limit: none of these modes provoked one, so whether `retryCount` stays at 0 for it in production is unseen. A machine dying mid-handler.

## What this says to the Discord question

- **Is a killed alarm retried?** Yes, by the same rule as a throw, and the kill counts toward the six retries.
- **Is `retryCount` right after a kill?** Yes, 0 through 6. It restarts at 0 whenever a newer alarm is stored, which is what a catch-and-re-arm handler does.
- **Is anything signalled when the retries run out?** No. Each failed attempt is its own log line and Issue, and afterwards `getAlarm()` keeps answering the old, past time rather than `null`.
- **When to give up re-arming?** The runtime's limit covers only what escapes the handler, and a re-arm that lands before a kill resets it. A handler that catches and re-arms needs its own attempt counter in storage: increment it and make it durable before the risky work, clear it on success, and give up after N. Re-arm at the end of the handler, not the start, and never gate a re-arm on `getAlarm() === null`.

Draft reply:

> Measured on a deployed Worker: yes, CPU kills, memory kills and `ctx.abort()` are retried exactly like a throw, and they count — 7 attempts, `retryCount` 0..6, backoff 2/4/8/16/32/64 s. When the retries run out nothing fires: no log line, no Issue beyond the per-attempt ones. One gotcha: afterwards `getAlarm()` still returns the old (past) time, not `null`, so don't gate a re-arm on `getAlarm() === null`. And since you catch and re-arm, note that a `setAlarm` that commits before a kill replaces the retry and resets `retryCount` to 0 — a job that re-arms first and then gets killed every time loops forever. Keep your own attempt counter in storage (write it, let it commit, then do the work; clear it on success) and give up after N.
