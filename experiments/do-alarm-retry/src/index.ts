import { DurableObject } from 'cloudflare:workers';

// How does the production alarm scheduler retry an `alarm()` that fails, and what does the handler
// see on each retry? Read from workerd's source on 2026-10-15 (`runAlarm` in api/global-scope.c++,
// server/alarm-scheduler.c++); the production scheduler is closed source, so this measures it.
//
// One probe object per mode. Every attempt records itself in SQLite and waits for the write to be
// durable BEFORE it fails, so the log survives a kill. The modes:
//   throw          — the handler throws
//   abort          — ctx.abort()
//   abort-noretry  — ctx.abort(reason, { retryAlarm: false })
//   cpu            — an infinite loop, killed by the CPU limit
//   memory         — allocates until the isolate's memory limit kills it
//   reset          — waits 90 s, during which the driver redeploys the Worker, then succeeds
//   rearm-abort    — setAlarm(+10 s), made durable, then ctx.abort(); stops after 6 attempts
//   rearm-throw    — setAlarm(+10 s), made durable, then throws; stops after 6 attempts

const MODES = ['throw', 'abort', 'abort-noretry', 'cpu', 'memory', 'reset', 'rearm-abort', 'rearm-throw'] as const;
type Mode = (typeof MODES)[number];

const REARM_DELAY_MS = 10_000;
const REARM_ATTEMPTS = 6;
const RESET_HOLD_MS = 90_000;

const macrotask = () => new Promise((r) => setTimeout(r, 0));
const iso = (ms: number) => new Date(ms).toISOString();

interface Attempt {
  seq: number;
  firedAt: string;
  scheduledTime: string;
  retryCount: number | null;
  isRetry: number | null;
  completedAt: string | null;
}

export class Probe extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS Attempts (
      seq INTEGER PRIMARY KEY, firedAt TEXT NOT NULL, scheduledTime TEXT NOT NULL,
      retryCount INTEGER, isRetry INTEGER, completedAt TEXT)`);
  }

  async arm(name: string, mode: Mode): Promise<{ armedAt: string; alarmAt: string }> {
    this.ctx.storage.sql.exec('DELETE FROM Attempts');
    this.ctx.storage.kv.put('name', name);
    this.ctx.storage.kv.put('mode', mode);
    const now = Date.now();
    await this.ctx.storage.setAlarm(now + 2_000);
    return { armedAt: iso(now), alarmAt: iso(now + 2_000) };
  }

  async report(): Promise<{ mode: string | undefined; alarm: string | null; attempts: Attempt[] }> {
    const alarm = await this.ctx.storage.getAlarm();
    const attempts = this.ctx.storage.sql.exec<Attempt & Record<string, SqlStorageValue>>('SELECT * FROM Attempts ORDER BY seq').toArray();
    return { mode: this.ctx.storage.kv.get<string>('mode'), alarm: alarm === null ? null : iso(alarm), attempts };
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const mode = this.ctx.storage.kv.get<Mode>('mode');
    const name = this.ctx.storage.kv.get<string>('name');
    const firedAt = iso(Date.now());
    const scheduledTime = iso(info?.scheduledTime ?? 0);
    const retryCount = info?.retryCount ?? null;
    const isRetry = info === undefined ? null : info.isRetry ? 1 : 0;
    const seq = this.ctx.storage.sql
      .exec<{ seq: number }>(
        'INSERT INTO Attempts (firedAt, scheduledTime, retryCount, isRetry) VALUES (?, ?, ?, ?) RETURNING seq',
        firedAt, scheduledTime, retryCount, isRetry,
      )
      .one().seq;
    console.log(JSON.stringify({ probe: name, mode, seq, retryCount, isRetry, scheduledTime }));
    // Durable before failing: a write in the same turn as an abort is dropped (durable-objects.md).
    await this.ctx.storage.sync();
    await macrotask();

    switch (mode) {
      case 'throw':
        throw new Error('probe-throw');
      case 'abort':
        this.ctx.abort('probe-abort');
        return;
      case 'abort-noretry':
        this.ctx.abort('probe-abort-noretry', { retryAlarm: false });
        return;
      case 'cpu': {
        let x = seq;
        for (;;) x = (Math.imul(x, 31) + 7) | 0;
      }
      case 'memory': {
        const keep: number[][] = [];
        for (;;) keep.push(new Array(1 << 20).fill(keep.length));
      }
      case 'reset':
        await new Promise((r) => setTimeout(r, RESET_HOLD_MS));
        break;
      case 'rearm-abort':
      case 'rearm-throw':
        if (seq > REARM_ATTEMPTS) break;
        await this.ctx.storage.setAlarm(Date.now() + REARM_DELAY_MS);
        await this.ctx.storage.sync();
        await macrotask();
        if (mode === 'rearm-abort') this.ctx.abort('probe-rearm-abort');
        else throw new Error('probe-rearm-throw');
        return;
      default:
        break;
    }
    this.ctx.storage.sql.exec('UPDATE Attempts SET completedAt = ? WHERE seq = ?', iso(Date.now()), seq);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get('name');
    if (!name) return new Response('routes: /arm?name=&mode= /report?name=\n', { status: 404 });
    const stub = env.PROBE.getByName(name);
    if (url.pathname === '/arm') {
      const mode = url.searchParams.get('mode') as Mode;
      if (!MODES.includes(mode)) return new Response(`mode is one of ${MODES.join(', ')}\n`, { status: 400 });
      return Response.json(await stub.arm(name, mode));
    }
    if (url.pathname === '/report') return Response.json(await stub.report());
    return new Response('not found\n', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
