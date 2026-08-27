/**
 * ResidencyProbe — does a DETACHED long await survive the DO fast-hibernation clock,
 * and does a re-arming `setTimeout` heartbeat hold it?
 *
 * Faithfulness: the Galaxy's codegen turn runs as a mesh chain DETACHED after early-ack —
 * a floating promise continuing after the triggering request has answered (mesh
 * `executeEnvelope`'s post-ack task; `waitUntil` is a DO no-op). `fire()` reproduces that
 * exact runtime shape: it kicks `void #work(...)` and returns immediately, so nothing
 * in-flight pins the DO. The `held` arm additionally runs the SAME re-arming heartbeat
 * `Galaxy.chat` uses (5 s ticks, beating the ~10 s fast-hibernation clock).
 *
 * Detector: `#bootId` (in-memory — changes on eviction+reconstruction) + storage markers.
 * `start` is written synchronously in `fire`; `finish` only lands if the floating await
 * reached its end IN THE SAME ISOLATE (the marker records both boot ids). An evicted arm
 * simply never writes `finish` — the silent-death shape the heartbeat exists to prevent.
 */
import { DurableObject } from 'cloudflare:workers';

const HEARTBEAT_MS = 5_000;

interface Marker {
  at: string;
  bootId: string;
}

export class ResidencyProbe extends DurableObject {
  #bootId = crypto.randomUUID();
  #heartbeat?: ReturnType<typeof setTimeout>;

  /** Kick the detached work and return AT ONCE — the request that triggered it is over. */
  fire(arm: 'held' | 'control', ms: number): { started: true; bootId: string } {
    this.ctx.storage.kv.put(`start:${arm}`, { at: new Date().toISOString(), bootId: this.#bootId } satisfies Marker);
    this.ctx.storage.kv.delete(`finish:${arm}`);
    void this.#work(arm, ms);
    return { started: true, bootId: this.#bootId };
  }

  async #work(arm: 'held' | 'control', ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    if (arm === 'held') {
      const beat = () => {
        // Each tick leaves a durable trace, so the FINAL status shows how long the
        // isolate survived (the eviction-window measurement).
        this.ctx.storage.kv.put('beat:held', { at: new Date().toISOString(), bootId: this.#bootId } satisfies Marker);
        if (Date.now() >= deadline) return;
        this.#heartbeat = setTimeout(beat, HEARTBEAT_MS);
      };
      beat();
    }
    try {
      // One long timer await — the env.AI-shaped detached wait under test. A single
      // setTimeout(ms) would itself be a residency signal on the control arm, so the
      // control uses ONE timer too (identical shape); the held arm differs ONLY by the
      // extra re-arming heartbeat, isolating the heartbeat as the variable.
      await new Promise((r) => setTimeout(r, ms));
      this.ctx.storage.kv.put(`finish:${arm}`, { at: new Date().toISOString(), bootId: this.#bootId } satisfies Marker);
    } finally {
      if (this.#heartbeat) { clearTimeout(this.#heartbeat); this.#heartbeat = undefined; }
    }
  }

  status(): Record<string, unknown> {
    return {
      currentBootId: this.#bootId,
      heldStart: this.ctx.storage.kv.get('start:held') ?? null,
      heldLastBeat: this.ctx.storage.kv.get('beat:held') ?? null,
      heldFinish: this.ctx.storage.kv.get('finish:held') ?? null,
      controlStart: this.ctx.storage.kv.get('start:control') ?? null,
      controlFinish: this.ctx.storage.kv.get('finish:control') ?? null,
    };
  }
}
