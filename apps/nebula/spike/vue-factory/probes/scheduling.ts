/**
 * Pre-probe: validate @vue/reactivity scheduling semantics before committing to Phase 0.
 *
 * Questions to answer:
 *   1. Is `effect()` synchronous or microtask-deferred on a reactive write?
 *   2. Can we read a module-scope `currentWritePath` sidecar from inside an effect callback?
 *   3. Does an ancestor write (replace entire subtree) fire effects that read into descendants?
 *   4. Does writing a structurally-equal-but-new-reference value fire effects?
 *   5. Does writing the IDENTICAL value (same reference) fire effects?
 */

import { reactive, effect, pauseTracking, resetTracking } from '@vue/reactivity';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string) {
  const marker = cond ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (cond) pass++; else fail++;
}

// ────────────────────────────────────────────────────────────────────────────
// Q1: Is effect() synchronous after a reactive write?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q1: effect() scheduling — sync or microtask? ===');
  const state: any = reactive({ a: { b: { c: 'initial' } } });
  const log: string[] = [];

  effect(() => {
    log.push(`read=${state.a.b.c}`);
  });
  // After registration, effect ran once.
  check('Q1.1 effect ran on registration', log.length === 1 && log[0] === 'read=initial');

  state.a.b.c = 'updated';
  check(
    'Q1.2 effect re-fires SYNCHRONOUSLY after assignment',
    log.length === 2 && log[1] === 'read=updated',
    `log=${JSON.stringify(log)}`,
  );

  // Second write to confirm still sync (not just first-flush).
  state.a.b.c = 'third';
  check('Q1.3 second assignment also sync', log.length === 3 && log[2] === 'read=third');
}

// ────────────────────────────────────────────────────────────────────────────
// Q2: Can a module-scope sidecar carry the write path INTO the effect cb?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q2: module-scope currentWritePath sidecar ===');
  let currentWritePath: string | null = null;
  const state: any = reactive({ a: { b: 1, c: 2 } });
  const observed: Array<{ value: number; path: string | null }> = [];

  effect(() => {
    // Reads `state.a.b` — registers as dep.
    observed.push({ value: state.a.b, path: currentWritePath });
  });
  check('Q2.1 initial fire sees null path', observed.length === 1 && observed[0].path === null);

  currentWritePath = 'a.b';
  state.a.b = 10;
  currentWritePath = null;
  check(
    'Q2.2 effect saw sidecar path during synchronous re-fire',
    observed.length === 2 && observed[1].path === 'a.b' && observed[1].value === 10,
    `observed=${JSON.stringify(observed)}`,
  );

  // Sibling write — should NOT fire effect (effect reads .b, not .c).
  currentWritePath = 'a.c';
  state.a.c = 20;
  currentWritePath = null;
  check('Q2.3 sibling write did NOT fire effect (correct dep tracking)', observed.length === 2);
}

// ────────────────────────────────────────────────────────────────────────────
// Q3: Ancestor write — replace entire subtree, descendant-reading effect fires?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q3: ancestor write fires descendant-reading effects? ===');
  const state: any = reactive({ a: { b: { c: 'initial' } } });
  const seen: string[] = [];

  effect(() => {
    seen.push(state.a.b.c);
  });
  check('Q3.1 initial fire', seen.length === 1 && seen[0] === 'initial');

  // Replace at `a.b` — descendant effect reads `a.b.c`.
  state.a.b = { c: 'replaced-at-b' };
  check(
    'Q3.2 replace at `a.b` fires descendant effect',
    seen.length === 2 && seen[1] === 'replaced-at-b',
    `seen=${JSON.stringify(seen)}`,
  );

  // Replace at `a` — should also fire.
  state.a = { b: { c: 'replaced-at-a' } };
  check(
    'Q3.3 replace at `a` fires descendant effect',
    seen.length === 3 && seen[2] === 'replaced-at-a',
    `seen=${JSON.stringify(seen)}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Q4: Structural-equality dedup — does Vue fire on equal-but-new-ref writes?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q4: structural-equal write fires effect? ===');
  const state: any = reactive({ a: { b: 1 } });
  let fires = 0;

  effect(() => {
    // Read the WHOLE `a` object — registers a dep on property `a` of root.
    JSON.stringify(state.a);
    fires++;
  });
  check('Q4.1 initial fire', fires === 1);

  // Replace `a` with structurally-equal but NEW-reference object.
  state.a = { b: 1 };
  check(
    'Q4.2 structurally-equal new ref FIRES effect (Vue does NOT dedup)',
    fires === 2,
    `Vue fires regardless of structural equality — confirms we must dedup at write-wrapper level`,
  );

  // Identity write — same reference re-assigned.
  const sameRef = state.a;
  state.a = sameRef;
  check(
    'Q4.3 same-reference write does NOT fire (Vue does identity dedup)',
    fires === 2,
    `Identity dedup is the only built-in dedup`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Q5: per-subscriber prev-value tracking pattern
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q5: per-effect prev-value capture for deep-equal dedup ===');
  const state: any = reactive({ a: { b: { c: 1, d: 2 } } });
  const fires: Array<{ newVal: any; oldVal: any; path: string | null }> = [];
  let currentWritePath: string | null = null;

  // Simulate subscribe('a.b.c', cb) — wrap effect with prev capture and deep-equal guard.
  let prev: any = undefined;
  let isFirst = true;
  effect(() => {
    const val = state.a.b.c;
    // Deep-equal check (here: shallow primitive compare suffices).
    if (isFirst) {
      isFirst = false;
      prev = val;
      fires.push({ newVal: val, oldVal: undefined, path: currentWritePath });
      return;
    }
    if (val === prev) return; // dedup
    fires.push({ newVal: val, oldVal: prev, path: currentWritePath });
    prev = val;
  });
  check('Q5.1 initial fire captured', fires.length === 1 && fires[0].newVal === 1);

  // Ancestor write that DOES change c
  currentWritePath = 'a.b';
  state.a.b = { c: 10, d: 2 };
  currentWritePath = null;
  check(
    'Q5.2 ancestor write that changes `c` fires once with correct old/new',
    fires.length === 2 && fires[1].newVal === 10 && fires[1].oldVal === 1 && fires[1].path === 'a.b',
    `fires=${JSON.stringify(fires)}`,
  );

  // Ancestor write that does NOT change c (changes only d) — Vue still fires the effect,
  // but our wrapper dedups based on `prev`.
  currentWritePath = 'a.b';
  state.a.b = { c: 10, d: 99 };
  currentWritePath = null;
  check(
    'Q5.3 ancestor write that does NOT change `c` is deduped by wrapper',
    fires.length === 2,
    `wrapper-level dedup works`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Q6: re-entrant write inside effect — does Vue allow it?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q6: write inside effect (computed-like pattern) ===');
  const state: any = reactive({ source: 1, derived: 0 });
  const derivedLog: number[] = [];

  effect(() => {
    derivedLog.push(state.source * 2);
    // Write to a different path during effect — should be fine.
    state.derived = state.source * 2;
  });
  check('Q6.1 effect with self-write runs', derivedLog.length === 1 && derivedLog[0] === 2);

  state.source = 5;
  check(
    'Q6.2 source change re-fires effect, derived updates',
    derivedLog.length === 2 && state.derived === 10,
    `derived=${state.derived}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Q7: nested effects — write inside effect fires NESTED effect synchronously?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q7: nested effects and write ordering ===');
  const state: any = reactive({ x: 1, y: 0 });
  const xLog: number[] = [];
  const yLog: number[] = [];

  effect(() => { xLog.push(state.x); state.y = state.x + 100; });
  effect(() => { yLog.push(state.y); });

  check('Q7.1 first effect ran, set y', xLog.length === 1 && state.y === 101);
  check('Q7.2 second effect ran, saw y=101', yLog.length === 1 && yLog[0] === 101);

  state.x = 2;
  check(
    'Q7.3 changing x cascaded to y synchronously',
    xLog.length === 2 && yLog.length === 2 && yLog[1] === 102,
    `xLog=${JSON.stringify(xLog)}, yLog=${JSON.stringify(yLog)}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Q8: Batching via pauseTracking — does it work as a flush deferral?
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Q8: pauseTracking semantics ===');
  // pauseTracking suppresses DEP tracking inside its scope (reads don't register as deps).
  // It does NOT defer effect FIRING on writes. Verify.
  const state: any = reactive({ a: 1, b: 1 });
  let fires = 0;
  effect(() => { state.a; state.b; fires++; });
  check('Q8.1 initial fire', fires === 1);

  pauseTracking();
  state.a = 2;
  state.b = 2;
  resetTracking();
  check(
    'Q8.2 pauseTracking did NOT defer effect firing (fires on writes anyway)',
    fires === 3,
    `fires=${fires} — pauseTracking is for read-side, not write-side batching`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n=== Summary: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
