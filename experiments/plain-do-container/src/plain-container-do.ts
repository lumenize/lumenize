import { DurableObject } from 'cloudflare:workers';

/**
 * SPIKE: a container-bound DO that does NOT `extends Container`.
 *
 * Q7 (done): plain DO + raw `ctx.container` constructs under pool-workers + drives the container.
 * Q3 (this pass): is the stuck state a `@cloudflare/containers` base-library artifact, or native to
 * raw `ctx.container`? Instruments the raw state surface + a health-probe recovery so we can inject
 * `docker pause` (the local stale-flag analog) and see whether a `.running`-gated drive wedges like
 * the base's `startContainerIfNotRunning` fast-path — and whether a probe-first recovery clears it.
 *
 * `ctx.container` is typed `any` — the spike deliberately avoids `wrangler types` regen.
 */
const rawContainer = (ctx: DurableObjectState): any =>
  (ctx as unknown as { container?: any }).container;

export class PlainContainerDO extends DurableObject {
  // No constructor override — touch NOTHING container-related at construction (the Q7 hypothesis).
  #monitor: any;
  // Q4 eviction detector: in-memory, changes iff the DO is evicted + reconstructed. (Spike-only
  // mutable instance state — the whole point is to observe in-memory-state survival across the window.)
  #bootId = crypto.randomUUID();
  #timeoutArmed = false;

  ping(): string {
    return 'pong';
  }

  containerApiPresent(): { hasContainer: boolean; startType: string } {
    const c = rawContainer(this.ctx);
    return { hasContainer: typeof c !== 'undefined', startType: c ? typeof c.start : 'undefined' };
  }

  /** Q2: drive via the RAW api — no `Container` helper. NOTE the `.running`-gated start (line marked). */
  async driveContainer(): Promise<string> {
    const c = rawContainer(this.ctx);
    if (!c) return 'NO_CONTAINER_API';
    if (!c.running) c.start(); // ← the base's fast-path pattern: gates start on the (stale-able) flag
    const port = c.getTcpPort(8080);
    for (let i = 0; i < 40; i++) {
      try {
        const res = await port.fetch('http://container.local/');
        return `OK(${res.status}): ${await res.text()}`;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return 'TIMEOUT waiting for container port :8080';
  }

  /** Q3: dump the raw `ctx.container` state surface — what signals exist beyond `.running`? */
  inspect(): unknown {
    const c = rawContainer(this.ctx);
    if (!c) return { hasContainer: false };
    const safe = (fn: () => unknown) => {
      try { return fn(); } catch (e) { return `<throw: ${String(e)}>`; }
    };
    return {
      hasContainer: true,
      running: safe(() => c.running),
      ownKeys: safe(() => Object.getOwnPropertyNames(c)),
      protoKeys: safe(() => Object.getOwnPropertyNames(Object.getPrototypeOf(c) ?? {})),
      stateType: safe(() => typeof c.state),
      stateVal: safe(() => (typeof c.state === 'function' ? c.state() : c.state)),
      getStateType: safe(() => typeof c.getState),
    };
  }

  /** Q3: a single BOUNDED health probe — distinguishes healthy / wedged-hang / error. */
  async probe(ms = 4000): Promise<unknown> {
    const c = rawContainer(this.ctx);
    if (!c) return { ok: false, reason: 'NO_CONTAINER_API' };
    try {
      const port = c.getTcpPort(8080);
      const res = await port.fetch('http://container.local/', { signal: AbortSignal.timeout(ms) });
      return { ok: true, status: res.status, body: await res.text(), runningFlag: c.running };
    } catch (e) {
      return { ok: false, error: String(e), runningFlag: c.running };
    }
  }

  /**
   * Q3: probe-first recovery that does NOT trust `.running` — `destroy()` + macrotask yield + `start()`,
   * then re-probe. Tests whether a wedge (`.running` stale-true, port dead) clears via the raw API.
   */
  async recover(): Promise<unknown> {
    const c = rawContainer(this.ctx);
    if (!c) return { reason: 'NO_CONTAINER_API' };
    const trace: Record<string, unknown> = { runningBefore: c.running };
    try { c.destroy?.(); trace.destroyed = true; } catch (e) { trace.destroyErr = String(e); }
    await new Promise((r) => setTimeout(r, 0)); // macrotask yield (persist-before-abort discipline analog)
    trace.runningAfterDestroy = c.running;
    try { if (!c.running) c.start(); trace.started = true; } catch (e) { trace.startErr = String(e); }
    for (let i = 0; i < 30; i++) {
      try {
        const res = await c.getTcpPort(8080).fetch('http://container.local/', { signal: AbortSignal.timeout(2000) });
        trace.recovered = `OK(${res.status})`;
        trace.attempts = i + 1;
        return trace;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    trace.recovered = false;
    trace.runningAfter = c.running;
    return trace;
  }

  /** Q3: cheap `.running` poll (does the flag update on a runtime cadence after a kill? — H2). */
  runningNow(): unknown {
    return { running: rawContainer(this.ctx)?.running };
  }

  /** Q3: the FIX candidate — call start() UNGATED (ignore .running), then probe. Does forcing a start recover a kill? */
  async forceStart(): Promise<unknown> {
    const c = rawContainer(this.ctx);
    if (!c) return { reason: 'NO_CONTAINER_API' };
    const trace: Record<string, unknown> = { runningBefore: c.running };
    try { c.start(); trace.startCalled = true; } catch (e) { trace.startErr = String(e); }
    for (let i = 0; i < 30; i++) {
      try {
        const res = await c.getTcpPort(8080).fetch('http://container.local/', { signal: AbortSignal.timeout(2000) });
        trace.recovered = `OK(${res.status})`; trace.attempts = i + 1; trace.runningAfter = c.running;
        return trace;
      } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    trace.recovered = false; trace.runningAfter = c.running;
    return trace;
  }

  /** Q3/Q5: attach the base's `monitor()` to test whether IT is what keeps `.running` accurate on instance-leave (H1). */
  async attachMonitor(): Promise<unknown> {
    const c = rawContainer(this.ctx);
    if (!c) return { reason: 'NO_CONTAINER_API' };
    if (!c.running) c.start();
    for (let i = 0; i < 30; i++) {
      try { await c.getTcpPort(8080).fetch('http://container.local/', { signal: AbortSignal.timeout(2000) }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    this.#monitor = c.monitor();
    (this.#monitor as Promise<unknown>).then(() => {}, () => {}); // observe; swallow
    return { monitorAttached: true, running: c.running };
  }

  // ---- Q4: does a keep-alive mechanism defeat the ~70–140s idle-eviction clock? ----
  // Detector = #bootId (in-memory): after a SILENT window, one terminal /boot probe — same id = survived,
  // different id = the DO was evicted + reconstructed. External prober compares; this DO stays silent.

  /** Terminal probe: the eviction signal. */
  bootInfo(): unknown {
    return { bootId: this.#bootId };
  }

  /** Arm the self-rescheduling ALARM keep-alive (each firing is an incoming event — does it reset the clock?). */
  async armAlarm(): Promise<unknown> {
    this.ctx.storage.kv.put('keepAlive', 1);
    await this.ctx.storage.setAlarm(Date.now() + 45_000); // 45s, under the ~70s idle floor
    return { armed: 'alarm', bootId: this.#bootId };
  }

  /** The base's alarm loop analog: while armed, reschedule so the alarm keeps firing. */
  async alarm(): Promise<void> {
    if (this.ctx.storage.kv.get('keepAlive')) {
      await this.ctx.storage.setAlarm(Date.now() + 45_000);
    }
  }

  /** Arm a self-rescheduling setTimeout (Q4b — does internal JS re-arming reset the eviction clock, or only an alarm?). */
  armTimeout(): unknown {
    this.#timeoutArmed = true;
    const tick = () => { if (this.#timeoutArmed) setTimeout(tick, 5_000); };
    setTimeout(tick, 5_000);
    return { armed: 'setTimeout', bootId: this.#bootId };
  }

  async disarm(): Promise<unknown> {
    this.ctx.storage.kv.delete('keepAlive');
    this.#timeoutArmed = false;
    await this.ctx.storage.deleteAlarm();
    return { disarmed: true };
  }

  /**
   * Q4-round-2 — the ACTUAL Phase-5 question: does a long IN-FLIGHT await keep the DO resident?
   * Compare the returned `bootId` to a `/boot` taken just before the call: same = the open request
   * held the same isolate for `ms` (resident); a hang/error = evicted mid-await.
   */
  async longAwait(ms: number): Promise<unknown> {
    await new Promise((r) => setTimeout(r, ms));
    return { bootId: this.#bootId, awaited: ms };
  }
}
