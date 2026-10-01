/**
 * ResidencyProbe — does a DETACHED long await survive the DO idle-eviction clock?
 *
 * Faithfulness: the Galaxy's codegen turn runs DETACHED — `void this.runTriggeredTurn(...)`
 * off the commit, so once the triggering request has answered nothing in-flight pins the
 * DO. Mesh's 4-arg callee does the same after its early ack (`executeEnvelope`'s post-ack
 * task, which it hands to `ctx.waitUntil`). `fire()` reproduces that runtime shape: it
 * kicks the work without awaiting it and returns at once. Each instance runs ONE arm.
 *
 * Round 1 (2026-08-28) arms, unchanged:
 *   - `control` — one long timer await.
 *   - `held`    — the same, plus a re-arming 5 s `setTimeout` heartbeat.
 * Round 2 (2026-10-01) arms, for the `durable_object_io_tasks_prevent_eviction` default:
 *   - `waitUntil`   — the `control` await, but handed to `ctx.waitUntil` (mesh's shape).
 *   - `binding`     — a service-binding request pending for the whole window.
 *   - `fetch`       — a global `fetch()` pending for the whole window (Galaxy's REST lane).
 *   - `fetchStream` — a `fetch()` whose body drips for the whole window (the REST lane
 *                     when a delta sink makes it stream).
 *   - `ai`          — a real `env.AI.run` on the Studio model (the binding lane). Its
 *                     duration is recorded: it only says anything if it outlasted the
 *                     eviction window, which a model call does not reliably do.
 *
 * Detector: `#bootId` (in-memory — changes on eviction + reconstruction) + storage markers.
 * `start` is written synchronously in `fire`; `finish` only lands if the detached await
 * reached its end, and records the boot id it ran in. An evicted arm never writes `finish`.
 * A thrown await writes `error` instead, so a plumbing failure never reads as an eviction.
 */
import { DurableObject } from 'cloudflare:workers';

const HEARTBEAT_MS = 5_000;
const STUDIO_MODEL = '@cf/moonshotai/kimi-k2.7-code';

export type Arm = 'control' | 'held' | 'waitUntil' | 'binding' | 'fetch' | 'fetchStream' | 'ai';
export const ARMS: readonly Arm[] = ['control', 'held', 'waitUntil', 'binding', 'fetch', 'fetchStream', 'ai'];

interface Marker {
  at: string;
  bootId: string;
  detail?: Record<string, unknown>;
}

export class ResidencyProbe extends DurableObject<Env> {
  #bootId = crypto.randomUUID();
  #heartbeat?: ReturnType<typeof setTimeout>;

  /** Kick the detached work and return AT ONCE — the request that triggered it is over. */
  fire(arm: Arm, ms: number, aiMaxTokens: number): { started: true; bootId: string } {
    this.ctx.storage.kv.put('arm', arm);
    this.ctx.storage.kv.put('start', this.#marker());
    this.ctx.storage.kv.delete('finish');
    this.ctx.storage.kv.delete('error');
    this.ctx.storage.kv.delete('beat');
    const work = this.#run(arm, ms, aiMaxTokens);
    if (arm === 'waitUntil') this.ctx.waitUntil(work);
    else void work;
    return { started: true, bootId: this.#bootId };
  }

  async #run(arm: Arm, ms: number, aiMaxTokens: number): Promise<void> {
    try {
      const detail = await this.#await(arm, ms, aiMaxTokens);
      this.ctx.storage.kv.put('finish', this.#marker(detail));
    } catch (e) {
      this.ctx.storage.kv.put('error', this.#marker({ message: e instanceof Error ? e.message : String(e) }));
    } finally {
      if (this.#heartbeat) { clearTimeout(this.#heartbeat); this.#heartbeat = undefined; }
    }
  }

  async #await(arm: Arm, ms: number, aiMaxTokens: number): Promise<Record<string, unknown> | undefined> {
    switch (arm) {
      case 'held': {
        const deadline = Date.now() + ms;
        const beat = () => {
          // Each tick leaves a durable trace, so the final status shows how long the
          // isolate survived.
          this.ctx.storage.kv.put('beat', this.#marker());
          if (Date.now() >= deadline) return;
          this.#heartbeat = setTimeout(beat, HEARTBEAT_MS);
        };
        beat();
        await new Promise((r) => setTimeout(r, ms));
        return undefined;
      }
      case 'control':
      case 'waitUntil':
        await new Promise((r) => setTimeout(r, ms));
        return undefined;
      case 'binding': {
        const res = await this.env.SLEEPER.fetch(`https://sleeper/sleep?ms=${ms}`);
        return { status: res.status, body: await res.text() };
      }
      case 'fetch': {
        const res = await fetch(`${this.env.SLEEPER_URL}/sleep?ms=${ms}`);
        return { status: res.status, body: (await res.text()).slice(0, 200) };
      }
      case 'fetchStream': {
        const res = await fetch(`${this.env.SLEEPER_URL}/drip?ms=${ms}`);
        if (!res.body) return { status: res.status, bytes: 0 };
        const reader = res.body.getReader();
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
        return { status: res.status, bytes };
      }
      case 'ai': {
        const t0 = Date.now();
        const out = await this.env.AI.run(STUDIO_MODEL as Parameters<Ai['run']>[0], {
          messages: [{
            role: 'user',
            content: 'Write a very long, exhaustive technical manual (aim for at least 12,000 words) on '
              + 'building a relational database engine from scratch: storage, B-trees, WAL, MVCC, '
              + 'query planning, joins, recovery. Use many sections and code samples. Do not stop early.',
          }],
          max_tokens: aiMaxTokens,
        } as never);
        // `Date.now()` advanced across the await (cf-clock-traps), so this is the call's wall time.
        const aiMs = Date.now() - t0;
        const text = JSON.stringify(out);
        return { aiMs, responseChars: text.length };
      }
    }
  }

  #marker(detail?: Record<string, unknown>): Marker {
    return { at: new Date().toISOString(), bootId: this.#bootId, ...(detail ? { detail } : {}) };
  }

  status(): Record<string, unknown> {
    return {
      currentBootId: this.#bootId,
      arm: this.ctx.storage.kv.get('arm') ?? null,
      start: this.ctx.storage.kv.get('start') ?? null,
      lastBeat: this.ctx.storage.kv.get('beat') ?? null,
      finish: this.ctx.storage.kv.get('finish') ?? null,
      error: this.ctx.storage.kv.get('error') ?? null,
    };
  }
}
