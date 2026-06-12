/**
 * Pre-probe (continued): can we implement `executeBatch` — last-write-wins per path,
 * single fanout at the end — using @vue/reactivity public API?
 *
 * Three candidate approaches:
 *   A. Queue writes in our wrapper, write all at flush time. Effects fire during flush.
 *      Risk: effect reading multiple paths fires once per affected path, not once total.
 *   B. ReactiveEffect with custom scheduler — defer the firing until flush.
 *   C. Use Vue's `watch` (microtask batching) instead of `effect` for subscribers.
 *      Trades sync-firing for built-in batching.
 */

import { reactive, effect, ReactiveEffect } from '@vue/reactivity';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail?: string) {
  const marker = cond ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (cond) pass++; else fail++;
}

// ────────────────────────────────────────────────────────────────────────────
// Approach A: queue writes, flush at batch end
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== A: queue-and-flush batching ===');
  const state: any = reactive({ a: { b: 1, c: 2 } });

  // Track an effect that depends on BOTH a.b and a.c
  let fires = 0;
  effect(() => { state.a.b; state.a.c; fires++; });
  check('A.1 initial fire', fires === 1);

  // Manually batch two writes that both feed the effect.
  const queue: Array<{ path: string[]; value: unknown }> = [];
  queue.push({ path: ['a', 'b'], value: 10 });
  queue.push({ path: ['a', 'c'], value: 20 });
  queue.push({ path: ['a', 'b'], value: 11 }); // last-write-wins for a.b

  // Dedup by path string before applying.
  const deduped = new Map<string, unknown>();
  for (const u of queue) {
    deduped.set(u.path.join('.'), u.value);
  }

  for (const [pathStr, value] of deduped) {
    const parts = pathStr.split('.');
    let cur: any = state;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }

  check(
    'A.2 effect fires once per writeS (not once total)',
    fires === 3, // initial + a.b write + a.c write
    `fires=${fires}; this is the "fires N times during flush, not 1" issue`,
  );
  check('A.3 final state correct (last-write-wins for a.b)', state.a.b === 11 && state.a.c === 20);
}

// ────────────────────────────────────────────────────────────────────────────
// Approach B: ReactiveEffect with custom scheduler
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== B: ReactiveEffect with scheduler — deferred firing ===');
  const state: any = reactive({ a: { b: 1, c: 2 } });

  let fires = 0;
  let dirty = false;

  // Build an effect that schedules instead of firing immediately.
  const re = new ReactiveEffect(() => { state.a.b; state.a.c; fires++; });
  re.scheduler = () => { dirty = true; };
  re.run(); // initial fire
  check('B.1 initial fire via run()', fires === 1);

  // Now writes will set `dirty` instead of firing.
  let batching = true;
  state.a.b = 10;
  state.a.c = 20;
  state.a.b = 11; // last-write-wins handled by Vue's identity dedup on same val? no — just overwrites
  check('B.2 effect deferred during batch (only scheduler ran)', fires === 1 && dirty === true);

  // Flush manually at batch end.
  if (dirty) {
    dirty = false;
    re.run();
  }
  batching = false;
  check(
    'B.3 single flush at batch end produced exactly ONE re-fire',
    fires === 2,
    `fires=${fires} — ReactiveEffect+scheduler gives us proper batching`,
  );
  check('B.4 state has final values', state.a.b === 11 && state.a.c === 20);
}

// ────────────────────────────────────────────────────────────────────────────
// Approach B': all-effects-flip-to-scheduler pattern (registry-based)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== B′: registry pattern — multiple subscribers, single flush ===');
  const state: any = reactive({ a: { b: 1, c: 2 } });

  // Track all our ReactiveEffects so we can flush all of them.
  const allEffects: Set<ReactiveEffect> = new Set();
  const dirtySet: Set<ReactiveEffect> = new Set();
  let isBatching = false;

  function subscribe(cb: () => void): () => void {
    const re = new ReactiveEffect(cb);
    re.scheduler = () => {
      if (isBatching) {
        dirtySet.add(re);
      } else {
        re.run();
      }
    };
    re.run();
    allEffects.add(re);
    return () => { allEffects.delete(re); re.stop(); };
  }

  function executeBatch(fn: () => void) {
    isBatching = true;
    try {
      fn();
    } finally {
      isBatching = false;
      // Flush every dirty effect — preserves last-write-wins because Vue trigger
      // already accumulated dep info, and each effect runs once.
      const toFlush = [...dirtySet];
      dirtySet.clear();
      for (const re of toFlush) re.run();
    }
  }

  let bSeen: number[] = [];
  let cSeen: number[] = [];
  let bothSeen: Array<{ b: number; c: number }> = [];

  subscribe(() => { bSeen.push(state.a.b); });
  subscribe(() => { cSeen.push(state.a.c); });
  subscribe(() => { bothSeen.push({ b: state.a.b, c: state.a.c }); });

  check(
    'B′.1 three subscribers fired initially',
    bSeen.length === 1 && cSeen.length === 1 && bothSeen.length === 1,
  );

  executeBatch(() => {
    state.a.b = 10;
    state.a.c = 20;
    state.a.b = 11; // last-write-wins
  });

  check(
    'B′.2 each subscriber fired EXACTLY ONCE at batch end',
    bSeen.length === 2 && cSeen.length === 2 && bothSeen.length === 2,
    `bSeen=${JSON.stringify(bSeen)}, cSeen=${JSON.stringify(cSeen)}, bothSeen=${JSON.stringify(bothSeen)}`,
  );
  check(
    'B′.3 each saw final values',
    bSeen[1] === 11 && cSeen[1] === 20 && bothSeen[1].b === 11 && bothSeen[1].c === 20,
  );

  // Outside batch: each write fires each affected subscriber once, immediately.
  state.a.b = 100;
  check(
    'B′.4 outside batch, single write fires its affected subscribers sync',
    bSeen.length === 3 && bSeen[2] === 100 && cSeen.length === 2 && bothSeen.length === 3,
  );
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n=== Summary: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
