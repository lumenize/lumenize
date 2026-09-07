/**
 * Phase 2–3 — the self-correcting codegen loop (tasks/archive/nebula-codegen-loop.md;
 * the per-write compile died with tasks/archive/nebula-move-compilers-out-of-the-worker.md —
 * a `write_file` is a pure write, and the container `build`'s per-step report is the
 * self-correction signal).
 *
 * Two layers, both container-free, no AI binding (the `dev-studio` project):
 *  - **Loop-logic unit tests** drive `runCodegenLoop` directly with injected fake
 *    deps + a synthetic model script — the bound (D4), loop-detection (D4, each
 *    operand mutated independently), the m2 malformed-envelope cases, and the user-layer
 *    build-report feedback round-trip (D1/D7/D8's successor).
 *  - **Galaxy integration tests** go through the real node (the `GalaxyLoopProbe`
 *    whose `callModel` replays a script): the real typia arg-validator facet (D5), the
 *    ENTRY's path rule reached through the real `write_file → writeSource` dep, the
 *    `build → buildNow` reach of the `LOOP_TOOL_ENTRIES` table, and the
 *    **secure-by-default D2 guard** — a written ontology never installs/wipes the
 *    `.dev` Star.
 *
 * @see tasks/archive/nebula-codegen-loop.md § Phases 2–3
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  runCodegenLoop,
  assembleCodegenPrompt,
  parseModelTurn,
  unknownToolArgKeys,
  DEFAULT_LOOP_CONFIG,
  type BuildReport,
  type CodegenLoopDeps,
  type LoopToolDeps,
  type CodegenLoopConfig,
  type ChatMessage,
  type ModelParams,
} from '../../../src/codegen-loop';
import { unwrapWorkersAiRest, workersAiRestHeaders, Galaxy, UNIVERSE_RESERVED_MESSAGE } from '../../../src/galaxy';
import { PLATFORM_FILES } from '../../../src/platform-embed';

/** A clean build report, shaped exactly as the host composes it. */
const cleanReport = (over: Partial<BuildReport> = {}): BuildReport => ({
  container: { ran: true, ok: true },
  ontology: { ran: false, why: 'no ontology change (host passed no version)' },
  typeCheck: { ran: true, checked: ['src/App.vue'], findings: [] },
  bundle: { ran: true, ok: true },
  preview: { refreshed: true, why: 'clean build' },
  ...over,
});

/** A report carrying type findings (advisory — bundle still ok, dist produced). */
const findingsReport = (findings: string[]): BuildReport => cleanReport({
  typeCheck: { ran: true, checked: ['src/App.vue'], findings },
  preview: { refreshed: false, why: 'type findings — preview refresh withheld by default (the model may override)' },
});

// ─── Fake-model + deps scaffolding (unit layer) ──────────────────────────

/** Build one OpenAI-shaped tool_call. */
const toolCall = (name: string, args: unknown, id = 'c0') => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
/** A raw tool_call whose `arguments` is intentionally non-JSON (m2a). */
const malformedToolCall = (name: string, badArgs: string, id = 'c0') => ({
  id, type: 'function', function: { name, arguments: badArgs },
});
/** Build one fake `env.AI.run` response (OpenAI shape). */
const resp = (toolCalls: unknown[], opts: { content?: string; reasoning?: string } = {}) => ({
  choices: [{ message: {
    content: opts.content ?? '',
    reasoning_content: opts.reasoning ?? '',
    tool_calls: toolCalls,
  } }],
});

const INITIAL = assembleCodegenPrompt({ systemBundles: ['sys'], userRequest: 'build a todo app' });

const GOOD_APP = `<script setup lang="ts">
import { ref } from 'vue';
const title = ref('');
</script>
<template><input v-model="title" /></template>`;

const BROKEN_ONTOLOGY = `interface Todo { title: ; done: boolean; }`;

interface Harness {
  deps: CodegenLoopDeps;
  writes: { path: string; content: string }[];
  /** The fake tree the read/edit fakes serve — seeded by the caller, written by `write_file`. */
  files: Map<string, string>;
  reads: string[];
  paramsSeen: ModelParams[];
  messagesSeen: ChatMessage[][];
}
/** `over` is flat for the call sites' sake: the tool deps (`read_file`, `write_file`,
 *  `edit_file`, `build`) are lifted into `deps.tools`, the loop's real shape; everything
 *  else overrides `deps` directly. The fakes are LOOP-level stand-ins — the real deps'
 *  behaviour (the entry's path rule, the anchor count, the `.platform/` resolution) is
 *  the Galaxy integration layer's subject, through the probe. */
function harness(
  script: unknown[],
  over: Partial<Omit<CodegenLoopDeps, 'tools'>> & Partial<LoopToolDeps> = {},
  seed: Record<string, string> = {},
): Harness {
  let i = 0;
  const writes: { path: string; content: string }[] = [];
  const files = new Map(Object.entries(seed));
  const reads: string[] = [];
  const paramsSeen: ModelParams[] = [];
  const messagesSeen: ChatMessage[][] = [];
  const { read_file, write_file, edit_file, build, ...rest } = over;
  const deps: CodegenLoopDeps = {
    callModel: async (messages, params) => {
      paramsSeen.push(params);
      messagesSeen.push(messages.map((m) => ({ ...m })));
      const r = script[i++];
      if (r === undefined) throw new Error('fake model script exhausted');
      return r;
    },
    tools: {
      read_file: read_file ?? (async (path) => {
        reads.push(path);
        const c = files.get(path);
        if (c === undefined) throw new Error(`no such file: ${path}`);
        return c;
      }),
      write_file: write_file ?? (async (path, content) => { writes.push({ path, content }); files.set(path, content); return { oid: `oid${writes.length}`, path }; }),
      edit_file: edit_file ?? (async (path, anchor, replacement) => {
        const c = files.get(path);
        if (c === undefined) throw new Error(`no such file: ${path}`);
        files.set(path, c.replace(anchor, () => replacement));
        writes.push({ path, content: files.get(path)! });
        return { oid: `oid${writes.length}`, path };
      }),
      build: build ?? (async () => cleanReport()),
    },
    validateToolArgs: async () => ({ ok: true }),
    ...rest,
  };
  return { deps, writes, files, reads, paramsSeen, messagesSeen };
}

describe('Phase 2 — loop driver: stop conditions (D4)', () => {
  it('write_file then mark_complete → stop=complete, file written once, PURE write (no check ran)', async () => {
    const h = harness([
      resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP })]),
      resp([toolCall('mark_complete', {})]),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(h.writes).toEqual([{ path: 'src/App.vue', content: GOOD_APP }]);
    // A write does no work at all: its tool result confirms the save and nothing else,
    // and no build ran, so there is no report.
    expect(r.toolCalls[0]).toEqual({ name: 'write_file', args: { path: 'src/App.vue', content: GOOD_APP }, result: { written: 'src/App.vue' } });
    expect(r.lastBuild).toBeUndefined();
    expect(r.appliedPaths).toEqual(['src/App.vue']);
  });

  it('never calls mark_complete → the maxToolDepth cap stops it', async () => {
    // 5 DISTINCT clean writes (distinct → no loop-detection), cap = 3.
    const script = [0, 1, 2, 3, 4].map((n) =>
      resp([toolCall('write_file', { path: 'src/App.vue', content: `<template><p>round ${n}</p></template>` })]));
    const r = await runCodegenLoop(INITIAL, harness(script).deps, { ...DEFAULT_LOOP_CONFIG, maxToolDepth: 3 });
    // Capable-of-failing: without the cap the loop would run all 5 then throw on
    // script-exhaustion — a different failure. The cap stops it at round 3.
    expect(r.stop).toBe('max-depth');
    expect(r.rounds).toBe(3);
  });

  it('a model call that THROWS ends the turn as a controlled error, never an uncaught throw', async () => {
    // 2026-09-06: a Workers AI 429 threw out of the turn; no reply landed and the client
    // waited on nothing for its whole budget. Mutation: drop the try/catch around
    // `deps.callModel` → the loop rejects → red.
    const h = harness([resp([toolCall('mark_complete', {})])], {
      callModel: async () => { throw new Error('Workers AI REST 429 at /ai/run/x'); },
    });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('error');
    expect(r.detail).toContain('429');
    expect(r.rounds).toBe(1);
    expect(r.toolCalls).toEqual([]);
  });

  it('the REST lane retries a 429 twice with backoff, then fails into the loop', async () => {
    // Mutation: drop the retry loop in `#callModelRest` → one call and a throw on the first 429.
    const dev = uniqueGalaxyScope();
    const once = (await inDO(env.GALAXY, dev, (s) => s.runRestStatusesForTest([429, 200]))) as { calls: number; error?: string };
    expect(once).toEqual({ calls: 2 });
    const always = (await inDO(env.GALAXY, dev, (s) => s.runRestStatusesForTest([429, 503, 429, 429]))) as { calls: number; error?: string };
    expect(always.calls).toBe(3);
    expect(always.error).toMatch(/Workers AI REST 429/);
    const plain = (await inDO(env.GALAXY, dev, (s) => s.runRestStatusesForTest([400]))) as { calls: number; error?: string };
    expect(plain).toEqual({ calls: 1, error: expect.stringMatching(/400/) });
  });

  it('a build whose CONTAINER step failed is told once, and a second one ends the turn build-unavailable', async () => {
    // The box not running is not something the model's code can fix: the first failure gets
    // feedback that says so and says not to build again; a second `build` in the same turn
    // ends it, so a Galaxy without a box cannot spend the round cap discovering that
    // (2026-09-06: a container-free turn ran into the 14-minute deadline at 32 rounds).
    const noBox = () => ({ ...cleanReport(), container: { ran: true as const, ok: false as const, tail: 'no build container attached' } });
    const h = harness([
      resp([toolCall('build', {})]),
      resp([toolCall('build', {})]),
      resp([toolCall('build', {})]), // never reached — mutation: drop the second-failure stop → script exhausted, red
    ], { build: async () => noBox() });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('build-unavailable');
    expect(r.rounds).toBe(2);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['build', 'build']);
    const feedback = r.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
    expect(feedback.some((c) => c.includes('Do not call build again this turn'))).toBe(true);
    expect(feedback.some((c) => c.includes('Fix and call build again'))).toBe(false);
  });

  it('m2c: a text-only reply (no tool_calls) → safe termination (stop=no-tool-calls)', async () => {
    const r = await runCodegenLoop(INITIAL, harness([resp([], { content: 'I think you meant…' })]).deps);
    expect(r.stop).toBe('no-tool-calls');
  });
});

describe('Phase 2 — loop-detection: each operand mutated independently (D4)', () => {
  it('identical write_file repeat → loop-detected (the identical-call detector)', async () => {
    // Same call (path+content) twice; text DIFFERS each round so this isolates the
    // identical-call detector from the text-repetition detector.
    const call = toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP });
    const r = await runCodegenLoop(INITIAL, harness([
      resp([call], { content: 'attempt one' }),
      resp([call], { content: 'attempt two' }),
    ]).deps);
    expect(r.stop).toBe('loop-detected');
    expect(r.detail).toContain('repeated tool call');
  });

  it('repeated model text → loop-detected (the text-repetition detector)', async () => {
    // DISTINCT writes each round (no identical-call trigger) but SAME text → this
    // isolates the text-repetition detector.
    const r = await runCodegenLoop(INITIAL, harness([
      resp([toolCall('write_file', { path: 'src/App.vue', content: '<template><p>a</p></template>' })], { content: 'thinking…' }),
      resp([toolCall('write_file', { path: 'src/App.vue', content: '<template><p>b</p></template>' })], { content: 'thinking…' }),
    ]).deps);
    expect(r.stop).toBe('loop-detected');
    expect(r.detail).toContain('repeated model text');
  });
});

describe('Phase 2 — malformed envelopes + tool errors (m2), captured not crashed', () => {
  it('m2a: malformed tool arguments JSON → captured tool error, write not dispatched', async () => {
    const h = harness([
      resp([malformedToolCall('write_file', '{ not json')]),
      resp([toolCall('mark_complete', {})]),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(h.writes).toEqual([]); // never dispatched
    expect(r.toolCalls[0].error).toContain('malformed tool arguments');
  });

  it('m2b: unknown tool name → captured tool error, loop continues', async () => {
    const h = harness([
      resp([toolCall('frobnicate', { x: 1 })]),
      resp([toolCall('mark_complete', {})]),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(r.toolCalls[0].error).toContain("unknown tool 'frobnicate'");
  });

  it('a write_file dep that THROWS is captured (not an uncaught crash); loop continues', async () => {
    const h = harness(
      [
        resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP })]),
        resp([toolCall('mark_complete', {})]),
      ],
      { write_file: async () => { throw new Error('disk boom'); } },
    );
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(r.toolCalls[0].error).toContain('disk boom');
    expect(r.appliedPaths).toEqual([]); // a throwing write never counts as applied
  });

  it('mark_complete with a stray key is refused like any other call, and the turn CONTINUES', async () => {
    // The gate runs before the short-circuit — mutation: move `mark_complete`'s return
    // above `validateToolArgs` → the first round ends the turn `complete` → red.
    const h = harness([
      resp([toolCall('mark_complete', { reason: 'done' }, 'c0')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { validateToolArgs: async (name, a) => {
      const unknown = unknownToolArgKeys(name, a);
      return unknown.length > 0 ? { ok: false, error: `unknown key on ${name} args: '${unknown[0]}'` } : { ok: true };
    } });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.rounds).toBe(2);
    expect(r.toolCalls[0]).toEqual({ name: 'mark_complete', args: { reason: 'done' }, error: "unknown key on mark_complete args: 'reason'" });
    expect(r.stop).toBe('complete');
  });

  it('invalid tool-call args (typia reject) → tool error, never dispatched', async () => {
    const h = harness(
      [
        resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP })]),
        resp([toolCall('mark_complete', {})]),
      ],
      // Refuse the WRITE only — the gate now runs for `mark_complete` too, so a fake that
      // refused everything would never let the turn end.
      { validateToolArgs: async (name) => (name === 'write_file' ? { ok: false, error: 'bad shape' } : { ok: true }) },
    );
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(h.writes).toEqual([]);
    expect(r.toolCalls[0].error).toBe('bad shape');
  });
});

// (The former loop-level path-safety block moved to the Galaxy integration layer below:
// the path rule now lives in the ENTRY — `assertModelPath` runs first inside `writeSource` —
// so a unit harness with a fake `write_file` dep cannot see it. `path-guard.test.ts`
// enumerates the rule's operands.)

describe('Phase 2 — the build report round-trips into the next round (D1/D7/D8\'s successor)', () => {
  it('a build with findings pushes findings-plus-touched-files into the next round\'s user layer', async () => {
    const FINDING = "src/App.vue(3,7): error TS2339: Property 'frobnicate' does not exist on type 'Client'.";
    const h = harness([
      resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP }, 'w1')]),
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async () => findingsReport([FINDING]) });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(r.lastBuild?.typeCheck.findings).toEqual([FINDING]);
    // The round-3 transcript (what the model saw after the build) carries the findings
    // AND the files written this turn in a user-role message — the self-correction
    // signal, no single file's source re-echoed (the diagnostics carry file + line).
    const round3 = h.messagesSeen[2];
    const userFeedback = round3.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(userFeedback).toContain('The build reported problems');
    expect(userFeedback).toContain(FINDING);
    expect(userFeedback).toContain('Files written this turn: src/App.vue');
  });

  it('a failed ontology step round-trips its tail the same way (each operand of the fix trigger)', async () => {
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {
      build: async () => cleanReport({
        ontology: { ran: true, ok: false, tail: 'Ontology type name "_Bad" starts with "_"' },
        preview: { refreshed: false, why: 'ontology compile failed — preview refresh withheld by default' },
      }),
    });
    const r = await runCodegenLoop(INITIAL, h.deps);
    const round2 = h.messagesSeen[1];
    const userFeedback = round2.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(userFeedback).toContain('ontology step failed');
    expect(userFeedback).toContain('starts with "_"');
    expect(r.stop).toBe('complete');
  });

  it('a failed container step carries its tail, and the feedback says NOT to build again', async () => {
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {
      build: async () => cleanReport({
        container: { ran: true, ok: false, tail: 'build job killed (failed, exit 137) — likely the 180000 ms build timeout' },
        ontology: { ran: false, why: 'the build job did not run' },
        typeCheck: { ran: false, checked: [], findings: [] },
        bundle: { ran: false, why: 'the build job did not run' },
        preview: { refreshed: false, why: 'the build job did not run' },
      }),
    });
    const r = await runCodegenLoop(INITIAL, h.deps);
    const round2 = h.messagesSeen[1];
    const userFeedback = round2.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(userFeedback).toContain('The build box did not run');
    expect(userFeedback).toContain('build timeout');
    // The timeout line rides the STEP's own tail (state-dependent result reading lives on
    // the report). A container failure is not the model's to fix, so its feedback says not
    // to build again this turn and never "fix and call build again" (that sentence is the
    // bundle/findings feedback's) — no second copy of the timeout advice, no preview-override
    // instruction (that is the tool description's). Mutation: route a container failure
    // through `buildReportFeedback` → red.
    expect(userFeedback).toMatch(/Do not call build again this turn/);
    expect(userFeedback).not.toContain('Fix and call build again');
    expect(userFeedback).not.toMatch(/preview|publish|simplify/i);
    expect(r.stop).toBe('complete');
  });
});

describe('the read and edit tools (loop-level; the real deps are the Galaxy layer\'s below)', () => {
  it('read_file: the model gets the content, the RECORD gets { path, bytes }', async () => {
    const VISION = '# Vision\nA wishlist app.';
    const h = harness([
      resp([toolCall('read_file', { path: 'docs/vision.md' }, 'r1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {}, { 'docs/vision.md': VISION });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(h.reads).toEqual(['docs/vision.md']);
    // The record never carries the content — it fans to every chat subscriber.
    expect(r.toolCalls[0]).toEqual({ name: 'read_file', args: { path: 'docs/vision.md' }, result: { path: 'docs/vision.md', bytes: VISION.length } });
    expect(JSON.stringify(r.toolCalls[0])).not.toContain('wishlist');
    // The model DID get it, as the tool result.
    const toolMsg = r.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'r1');
    expect(JSON.parse(toolMsg!.content)).toEqual({ path: 'docs/vision.md', content: VISION });
    expect(r.appliedPaths).toEqual([]); // a read applies nothing
  });

  it('read_file of an absent path is a captured tool error and the turn continues to its reply', async () => {
    const h = harness([
      resp([toolCall('read_file', { path: 'src/nope.vue' }, 'r1')]),
      resp([], { content: 'There is no such component.' }),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.toolCalls[0].error).toBe('no such file: src/nope.vue');
    expect(r.stop).toBe('no-tool-calls');
    expect(r.output).toBe('There is no such component.'); // the reply still lands
  });

  it('two consecutive IDENTICAL read_file calls do not end the turn loop-detected (a read is idempotent)', async () => {
    // The retro is read → edit → read of the same file. Mutation: drop `read_file` from
    // LOOP_DETECTOR_EXEMPT → the second read ends the turn `loop-detected` → red.
    const h = harness([
      resp([toolCall('read_file', { path: 'AGENTS.md' }, 'r1')], { content: 'first look' }),
      resp([toolCall('read_file', { path: 'AGENTS.md' }, 'r2')], { content: 'second look' }),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {}, { 'AGENTS.md': '# App' });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(h.reads).toEqual(['AGENTS.md', 'AGENTS.md']);
    // The positive control for the exemption: an identical WRITE still trips the detector
    // (asserted in the loop-detection block above), so this is the exemption at work.
  });

  it('edit_file: the dep is called with (path, anchor, replacement); the edited path is APPLIED', async () => {
    const h = harness([
      resp([toolCall('edit_file', { path: 'AGENTS.md', anchor: '# App', replacement: '# App\n- No timers.' }, 'e1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {}, { 'AGENTS.md': '# App\n' });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(h.files.get('AGENTS.md')).toBe('# App\n- No timers.\n');
    expect(r.appliedPaths).toEqual(['AGENTS.md']);
    expect(r.toolCalls[0]).toEqual({
      name: 'edit_file', args: { path: 'AGENTS.md', anchor: '# App', replacement: '# App\n- No timers.' }, result: { edited: 'AGENTS.md' },
    });
  });

  it('an edit_file dep that THROWS (an absent or ambiguous anchor, in the real dep) is a captured tool error', async () => {
    const h = harness([
      resp([toolCall('edit_file', { path: 'AGENTS.md', anchor: 'x', replacement: 'y' }, 'e1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { edit_file: async () => { throw new Error('edit_file: anchor matches 2 times in AGENTS.md — nothing written; widen it so it matches once'); } });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(r.toolCalls[0].error).toContain('anchor matches 2 times');
    expect(r.appliedPaths).toEqual([]);
  });
});

describe('unknownToolArgKeys — the excess-key refusal the typia facet cannot make', () => {
  it('names the keys a tool does not declare, sorted; declared keys pass', () => {
    expect(unknownToolArgKeys('build', { preview: true })).toEqual([]);
    expect(unknownToolArgKeys('build', { publish: true })).toEqual(['publish']);
    expect(unknownToolArgKeys('write_file', { path: 'a', content: 'b', mode: 'x', zeta: 1 })).toEqual(['mode', 'zeta']);
    expect(unknownToolArgKeys('mark_complete', { reason: 'done' })).toEqual(['reason']);
    expect(unknownToolArgKeys('edit_file', { path: 'a', anchor: 'b', replacement: 'c' })).toEqual([]);
  });
  it('an unknown tool declares nothing, so every key is unknown; non-object args have no keys to judge', () => {
    expect(unknownToolArgKeys('frobnicate', { x: 1 })).toEqual(['x']);
    expect(unknownToolArgKeys('build', 'not an object')).toEqual([]);
    expect(unknownToolArgKeys('build', null)).toEqual([]);
  });
});

describe('Phase 3 — prompt assembly (D7, re-derived for the cache) + per-call params (D6)', () => {
  it('assembleCodegenPrompt: the bundles ride the system block in order; the ontology, source and request are the user block', () => {
    // The ontology LEFT the system block (it changes most turns and would invalidate every
    // cached token after it) — this assertion inverted when it moved; the bundle presence
    // carried over.
    const { system, user } = assembleCodegenPrompt({
      systemBundles: ['BUNDLE-A', 'BUNDLE-B'],
      ontologyDts: 'interface Todo { title: string }',
      userRequest: 'add a priority field',
      currentSource: '<template>X</template>',
      posterLabel: 'human 2',
    });
    expect(system.role).toBe('system');
    expect(system.content).toBe('BUNDLE-A\n\nBUNDLE-B');
    expect(system.content).not.toContain('interface Todo');
    expect(system.content).not.toContain('add a priority field');
    expect(user.role).toBe('user');
    // Ontology, then the current source, then the request marked with its poster.
    const ontologyAt = user.content.indexOf('interface Todo { title: string }');
    const sourceAt = user.content.indexOf('<template>X</template>');
    const requestAt = user.content.indexOf('User request (human 2): add a priority field');
    expect(ontologyAt).toBeGreaterThanOrEqual(0);
    expect(sourceAt).toBeGreaterThan(ontologyAt);
    expect(requestAt).toBeGreaterThan(sourceAt);
  });

  it('the system layer of a REAL turn: contract, platform (the resource core + catalog), the Galaxy file — in that order, no ontology', async () => {
    const dev = uniqueGalaxyScope();
    const { seenMessages } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'hello', [aiResp([], { content: 'hi' })],
    ))) as any;
    const system = seenMessages[0][0] as { role: string; content: string };
    expect(system.role).toBe('system');
    const at = (needle: string) => { const i = system.content.indexOf(needle); expect(i, needle).toBeGreaterThanOrEqual(0); return i; };
    // (a) the resource core's sentences and the catalog line for the resources doc…
    const contractAt = at('You are Studio');
    const coreAt = at('Resources are the only place user data lives');
    at('read `.platform/docs/resources.md`');
    at('- define-ontology — ');
    at('(.platform/skills/define-ontology/SKILL.md)');
    // …the Galaxy layer (seeded into every new Workspace), after the platform's…
    const galaxyAt = at('# Guidance for this app');
    expect(contractAt).toBeLessThan(coreAt);
    expect(coreAt).toBeLessThan(galaxyAt);
    // …and NO ontology in the system block (it rides the user message).
    expect(system.content).not.toContain('interface Item');
    expect(system.content).not.toContain('src/ontology.d.ts) is:');
    const user = seenMessages[0][1] as { role: string; content: string };
    expect(user.content).toContain('interface Item');
    expect(user.content).toContain('User request');
    // No history on turn one of a direct-probe turn (no chat, no call context) — (h)'s in-lane twin
    // is the baseline history test; here it proves the bundle is omitted rather than rendered empty.
    expect(system.content).not.toContain('Chat history —');
  });

  it('(b) a line added to AGENTS.md appears byte-for-byte in the next turn\'s system layer; a Workspace WITHOUT it runs and replies', async () => {
    const dev = uniqueGalaxyScope();
    const LINE = '- Never show the draw to anyone but the organizer. (added by a participant)';
    await inDO(env.GALAXY, dev, async (s) => {
      const cur = await s.readSource('AGENTS.md');
      await s.writeSource('AGENTS.md', `${cur}${LINE}\n`);
    });
    const withIt = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest('next', [aiResp([], { content: 'ok' })]))) as any;
    expect((withIt.seenMessages[0][0] as { content: string }).content).toContain(LINE);
    // Mutation: stop injecting the Galaxy layer → the line is nowhere in the prompt → red.
    // Now WITHOUT the file — a Galaxy seeded before the layer existed: the turn runs, the
    // layer is omitted (not rendered empty), and the reply lands.
    await inDO(env.GALAXY, dev, (s) => s.removeFileForTest('AGENTS.md'));
    const without = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest('again', [aiResp([], { content: 'still fine' })]))) as any;
    const system = (without.seenMessages[0][0] as { content: string }).content;
    expect(system).not.toContain(LINE);
    expect(system).not.toContain("The app's own AGENTS.md");
    expect(system).toContain('Resources are the only place user data lives'); // the platform layer still rides
    expect(without.result.stop).toBe('no-tool-calls');
    expect(without.result.output).toBe('still fine');
  });

  it('(c) the session-affinity header rides BOTH lanes, keyed {u}.{g}:main', async () => {
    const dev = uniqueGalaxyScope();
    const { options, headers } = (await inDO(env.GALAXY, dev, (s) => s.runModelViaBindingForTest())) as {
      options: { extraHeaders?: Record<string, string> }; headers: Record<string, string>;
    };
    // The binding lane: the options `runModel` passes to `env.AI.run` — mutation: drop
    // `extraHeaders` from the binding call → `options` is undefined → red.
    expect(options?.extraHeaders?.['x-session-affinity']).toBe(`${dev}:main`);
    // The REST lane: the header map is a pure function of the token, the gateway and the
    // same headers — mutation: drop `...opts.extra` from `workersAiRestHeaders` → red.
    const rest = workersAiRestHeaders({ token: 't', gateway: 'g1', extra: headers });
    expect(rest['x-session-affinity']).toBe(`${dev}:main`);
    expect(rest['cf-aig-gateway-id']).toBe('g1');
    expect(rest.Authorization).toBe('Bearer t');
    expect(workersAiRestHeaders({ token: 't', extra: headers })['cf-aig-gateway-id']).toBeUndefined();
    // The REST lane at its CALL SITE — the headers `#callModelRest` hands the transport.
    // Mutation: `extra: {}` at that site → red; the pure map above cannot see it.
    const wire = (await inDO(env.GALAXY, dev, (s) => s.runModelViaRestForTest())) as Record<string, string>;
    expect(wire['x-session-affinity']).toBe(`${dev}:main`);
  });

  it('per-call params: round 1 uses generate params; the round after a findings build uses fix params (D6)', async () => {
    // The old trigger (a per-write compile error) died with the Worker-side gate —
    // fixMode's successor fires on ANY failed step or non-empty findings.
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async () => findingsReport(['src/App.vue(1,1): error TS2322: broken']) });
    const cfg: CodegenLoopConfig = {
      maxToolDepth: 8,
      generateParams: { temperature: 0.7, max_tokens: 100 },
      fixParams: { temperature: 0.1, max_tokens: 200 },
    };
    await runCodegenLoop(INITIAL, h.deps, cfg);
    expect(h.paramsSeen[0]).toEqual(cfg.generateParams);
    expect(h.paramsSeen[1]).toEqual(cfg.fixParams); // dropped to fix after the findings
  });
});

describe('Phase 2 — D2 structural guard: the loop names no install/wipe sink', () => {
  it('runCodegenLoop references none of the Star/DevContainer install/wipe symbols', () => {
    const src = runCodegenLoop.toString();
    for (const forbidden of [
      'resetDevData', 'setOntology', 'compileAndInstallOntology', 'STAR_BINDING',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

// ─── Galaxy integration layer (real node via the probe) ───

const uniqueGalaxyScope = () => `${crypto.randomUUID()}.app`;
const VALID_ONTOLOGY = `interface Todo { title: string; done: boolean; }`;

// Direct in-DO call — returns the method's result. The loop is LOCAL now (compile/
// validate/git in-DO, no cross-DO recorder), so this is faithful and gets the value.
const inDO = (binding: any, instance: string, fn: (inst: any) => unknown) =>
  (runInDurableObject as any)(binding.getByName(instance), fn);
const tc = toolCall;
const aiResp = resp;

describe('Phase 2/3 integration — real Galaxy loop (probe replays a script)', () => {
  it('clean write_file then mark_complete: commits the file + completes', async () => {
    const dev = uniqueGalaxyScope();
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'build a todo app',
      [aiResp([tc('write_file', { path: 'src/App.vue', content: GOOD_APP })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.stop).toBe('complete');
    expect(result.appliedPaths).toEqual(['src/App.vue']);
    // The real Workspace holds the committed file.
    expect(await inDO(env.GALAXY, dev, (s) => s.readSource('src/App.vue'))).toBe(GOOD_APP);
  });

  it.each([
    ['../escape', "'..' segment"],
    ['/abs/path', 'Absolute'],
    ['.nebula/ontology-row.json', 'Reserved path'],
  ])('the ENTRY\'s path rule: write_file(%s) is a captured tool error and nothing lands', async (path, needle) => {
    // The rule is `writeSource`'s own (`assertModelPath`), reached through the real
    // `write_file → writeSource` dep — so this proves the loop CAPTURES the entry's refusal
    // rather than crashing, and that the refused write never reached the tree. The seed
    // App.vue is the positive control: a landed write would have replaced it.
    const dev = uniqueGalaxyScope();
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'escape',
      [aiResp([tc('write_file', { path, content: 'x' })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.stop).toBe('complete');
    expect(result.toolCalls[0].error).toContain(needle);
    expect(result.appliedPaths).toEqual([]);
    const appVue = await inDO(env.GALAXY, dev, (s) => s.readSource('src/App.vue')) as string;
    expect(appVue).toContain('Seed App.vue');
  });

  it('the loop\'s build tool reaches the `buildNow` ENTRY (the LOOP_TOOL_ENTRIES table), not a private body', async () => {
    // Mutation: route `build` to `#buildAndAnnounce` directly → the spy sees no call.
    const spy = vi.spyOn(Galaxy.prototype, 'buildNow');
    try {
      const dev = uniqueGalaxyScope();
      const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
        'build',
        [aiResp([tc('build', { preview: true })]), aiResp([tc('mark_complete', {})])],
      ))) as any;
      expect(result.stop).toBe('complete');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ preview: true }); // the model's override rides the entry
      // …and the override DECIDED: the probe's faked bundle is ok, so the report says refreshed.
      const rec = result.toolCalls.find((t: { name: string }) => t.name === 'build');
      expect(rec.result.preview).toEqual({ refreshed: true, why: "refreshed on the model's override" });
    } finally {
      spy.mockRestore();
    }
  });

  it('the rename is TOTAL: `publish` is a dead key refused by NAME, and `preview` of the wrong type is a typia error', async () => {
    // The typia facet ignores excess keys, so without the by-name refusal a stale
    // `{ "publish": true }` would run a build WITHOUT the override the model asked for —
    // the exact silent shape the rename exists to prevent. Mutation: drop the unknown-key
    // check in `#validateToolArgs` → the build dispatches (spy called) and this reds.
    const spy = vi.spyOn(Galaxy.prototype, 'buildNow');
    try {
      const dev = uniqueGalaxyScope();
      const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
        'build',
        [
          aiResp([tc('build', { publish: true }, 'b1')]),
          aiResp([tc('build', { preview: 'yes' }, 'b2')]),
          aiResp([tc('mark_complete', {}, 'c1')]),
        ],
      ))) as any;
      expect(result.stop).toBe('complete');
      expect(spy).not.toHaveBeenCalled(); // neither refusal dispatched a build
      expect(result.toolCalls[0].error).toBe("unknown key on build args: 'publish'");
      expect(result.toolCalls[1].error).toMatch(/invalid build args — \$input\.preview: expected/);
    } finally {
      spy.mockRestore();
    }
  });

  it('read_file resolves in ONE order: .platform/ from the embed byte-for-byte, .universe/ reserved, else the Workspace', async () => {
    const dev = uniqueGalaxyScope();
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'read',
      [
        aiResp([tc('read_file', { path: '.platform/docs/resources.md' }, 'r1')]),
        aiResp([tc('read_file', { path: '.universe/AGENTS.md' }, 'r2')]),
        aiResp([tc('read_file', { path: 'src/App.vue' }, 'r3')]),
        aiResp([tc('read_file', { path: '.platform/docs/nope.md' }, 'r4')]),
        aiResp([tc('read_file', { path: 'src/nope.vue' }, 'r5')]),
        aiResp([], { content: 'looked around' }),
      ],
    ))) as any;
    const toolMsg = (id: string) => JSON.parse(result.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === id).content);
    // (b) the embedded page, byte-for-byte — mutation: point `.platform/` at the Workspace → ENOENT → red.
    expect(toolMsg('r1')).toEqual({ path: '.platform/docs/resources.md', content: PLATFORM_FILES['.platform/docs/resources.md'] });
    // `bytes` is UTF-8 bytes (the page holds non-ASCII), not UTF-16 code units.
    expect(result.toolCalls[0].result).toEqual({ path: '.platform/docs/resources.md', bytes: new TextEncoder().encode(PLATFORM_FILES['.platform/docs/resources.md']!).length });
    expect(result.toolCalls[1].error).toBe(UNIVERSE_RESERVED_MESSAGE);
    expect(toolMsg('r3').content).toContain('Seed App.vue'); // the Workspace, through readSource
    expect(result.toolCalls[3].error).toBe('no such platform file: .platform/docs/nope.md');
    expect(result.toolCalls[4].error).toBe('no such file: src/nope.vue');
    // The absent-path turn still ends with its reply — mutation: let the throw escape the
    // read dep → the loop's catch is bypassed and the turn ends `error`/throws → red.
    expect(result.stop).toBe('no-tool-calls');
    expect(result.output).toBe('looked around');
  });

  it('edit_file changes ONLY the matched span; zero or two-plus matches are refused with the file unchanged', async () => {
    const dev = uniqueGalaxyScope();
    const seed = await inDO(env.GALAXY, dev, (s) => s.readSource('src/App.vue')) as string;
    expect(seed).toContain('Your app is warming up…');
    // "Describe" occurs once in the seed; "class=" occurs several times; "zzz" never.
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'edit',
      [
        aiResp([tc('edit_file', { path: 'src/App.vue', anchor: 'zzz-absent', replacement: 'x' }, 'e1')]),
        aiResp([tc('edit_file', { path: 'src/App.vue', anchor: 'class=', replacement: 'x' }, 'e2')]),
        aiResp([tc('edit_file', { path: 'src/nope.vue', anchor: 'a', replacement: 'b' }, 'e3')]),
        aiResp([tc('edit_file', { path: 'src/App.vue', anchor: 'warming up…', replacement: 'READY' }, 'e4')]),
        aiResp([tc('mark_complete', {}, 'c1')]),
      ],
    ))) as any;
    expect(result.toolCalls[0].error).toMatch(/anchor not found in src\/App\.vue — nothing written/);
    expect(result.toolCalls[1].error).toMatch(/anchor matches \d+ times in src\/App\.vue — nothing written/);
    expect(result.toolCalls[2].error).toBe('no such file: src/nope.vue');
    expect(result.toolCalls[3]).toMatchObject({ name: 'edit_file', result: { edited: 'src/App.vue' } });
    expect(result.appliedPaths).toEqual(['src/App.vue']); // the two refusals applied nothing
    // Every other byte identical: the edit is the seed with exactly that span replaced —
    // mutation: drop the anchor count → the FIRST `class=` is edited silently → red.
    const after = await inDO(env.GALAXY, dev, (s) => s.readSource('src/App.vue')) as string;
    expect(after).toBe(seed.replace('warming up…', 'READY'));
  });

  it.each([
    ['write_file', '.platform/AGENTS.md'],
    ['write_file', '.universe/AGENTS.md'],
    ['write_file', '.nebula/ontology-row.json'],
    ['write_file', '.git/config'],
    ['write_file', '.env'],
    ['write_file', '.gitignore'],
    ['edit_file', '.platform/AGENTS.md'],
    ['edit_file', '.universe/AGENTS.md'],
    ['edit_file', '.nebula/ontology-row.json'],
    ['edit_file', '.git/config'],
    ['edit_file', '.env'],
    ['edit_file', '.gitignore'],
  ])('%s to the reserved path %s is refused BEFORE any write (the entry\'s rule)', async (tool, path) => {
    const dev = uniqueGalaxyScope();
    const args = tool === 'write_file' ? { path, content: 'x' } : { path, anchor: 'a', replacement: 'b' };
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'plant', [aiResp([tc(tool, args)]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.toolCalls[0].error).toMatch(/^Reserved path rejected for write/);
    expect(result.appliedPaths).toEqual([]);
    // Nothing landed under the reserved path: a read of it is ENOENT (a `.git/config`
    // read finds git's OWN file, so assert that one is not our 'x').
    const readBack = await inDO(env.GALAXY, dev, async (s) => { try { return await s.readSource(path); } catch { return null; } }) as string | null;
    expect(readBack === null || (!readBack.includes('x\n') && readBack !== 'x' && readBack !== 'b')).toBe(true);
  });

  it('.agents/skills/x/SKILL.md and ./src/App.vue are ACCEPTED by both write tools (the positive controls)', async () => {
    const dev = uniqueGalaxyScope();
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'allowed',
      [
        aiResp([tc('write_file', { path: '.agents/skills/x/SKILL.md', content: '---\nname: x\n---\n' }, 'w1')]),
        aiResp([tc('write_file', { path: './src/App.vue', content: GOOD_APP }, 'w2')]),
        aiResp([tc('edit_file', { path: './.agents/skills/x/SKILL.md', anchor: 'name: x', replacement: 'name: y' }, 'e1')]),
        aiResp([tc('mark_complete', {}, 'c1')]),
      ],
    ))) as any;
    expect(result.stop).toBe('complete');
    expect(result.toolCalls.map((t: { error?: string }) => t.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(result.appliedPaths).toEqual(['.agents/skills/x/SKILL.md', 'src/App.vue', '.agents/skills/x/SKILL.md']);
    expect(await inDO(env.GALAXY, dev, (s) => s.readSource('.agents/skills/x/SKILL.md'))).toBe('---\nname: y\n---\n');
    expect(await inDO(env.GALAXY, dev, (s) => s.readSource('src/App.vue'))).toBe(GOOD_APP);
  });

  it('D5: a non-string path is rejected by the REAL typia validator facet (never written)', async () => {
    const dev = uniqueGalaxyScope();
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'build',
      [aiResp([tc('write_file', { path: 123, content: 'x' })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.toolCalls[0].error).toContain('invalid write_file args');
    // Capable-of-failing: nothing landed in the Workspace. The scaffold seeds
    // src/App.vue at git-init (Phase 3), so ABSENCE is no longer the signal — assert
    // the SEED content is untouched (a landed write would have replaced it).
    const appVue = await inDO(env.GALAXY, dev, (s) => s.readSource('src/App.vue')) as string;
    expect(appVue).toContain('Seed App.vue');
    expect(result.appliedPaths).toEqual([]);
  });

  it('D2 SECURE-BY-DEFAULT: a hostile ontology write_file NEVER installs/wipes the .dev Star', async () => {
    const dev = uniqueGalaxyScope();
    const { result } = (await inDO(env.GALAXY, dev, (s) => s.runLoopForTest(
      'add a Todo type',
      [aiResp([tc('write_file', { path: 'src/ontology.d.ts', content: VALID_ONTOLOGY })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.stop).toBe('complete');
    // The ontology was written to the Workspace (a pure write — the container `build`
    // is where compiling happens now, and this turn never called it)…
    expect(await inDO(env.GALAXY, dev, (s) => s.readSource('src/ontology.d.ts'))).toBe(VALID_ONTOLOGY);
    expect(result.lastBuild).toBeUndefined();
    // …and it was NEVER installed on the derived .dev Star (no setOntology /
    // compileAndInstallOntology) and nothing was wiped. Capable-of-failing: an install
    // would leave a version in the Star's index. Only the dominion-gated
    // appendWorkspaceOntology appends; the loop cannot reach it.
    expect(await inDO(env.STAR, `${dev}.dev`, (s) => s.inspectOntologyIndex())).toEqual([]);
  });

  // (The two m4 recorder tests died with the `Turns` apparatus — an agent `Message` IS a
  // codegen turn; the corpus folds into its `codegen` value object in Phase 2 of
  // tasks/archive/nebula-galaxy-collapse-and-chat.md.)

  // (The `response_format: json_schema` Workers-AI capability probe was a one-off
  // investigation, not a regression — the shipping path is the typia post-validate of
  // tool-call args, fully covered above — so it's not kept as a placeholder test.)
});

// ─── Workers-AI REST envelope (Phase 2 callModel swap) ───────────────────────
//
// The hosted-lane `callModel` calls Workers AI over REST, which wraps the binding's
// result in `{ result, success, errors }`. `unwrapWorkersAiRest` must yield the SAME
// shape `env.AI.run` returns, so `parseModelTurn` reads it unchanged — otherwise the
// REST swap silently no-ops (zero tool_calls → loop "stops"). Cheap + deterministic
// (no fetch); only REST exercises the unwrap (the binding path returns the inner shape
// directly), so the ui-smoke GHA lane — which uses the binding — can't catch this.
describe('Phase 3 — the build TOOL (the per-step report as a tool result)', () => {
  it('a clean report round-trips as the tool result and the loop CONTINUES to mark_complete', async () => {
    const buildCalls: unknown[] = [];
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async (opts) => { buildCalls.push(opts); return cleanReport(); } });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(buildCalls).toEqual([{}]); // one cycle, no publish override passed
    const rec = r.toolCalls.find((t) => t.name === 'build');
    expect(rec?.result).toEqual(cleanReport());
    expect(r.lastBuild).toEqual(cleanReport());
    // The report went BACK TO THE MODEL as a tool message (the model reads every step).
    const toolMsg = r.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'b1');
    expect(toolMsg?.content).toContain('"container"');
    expect(toolMsg?.content).toContain('"preview"');
    expect(toolMsg?.content).not.toContain('"publish"');
    expect(toolMsg?.content).toContain('"why":"clean build"');
  });

  it('the model\'s preview override rides BuildArgs through to deps.tools.build', async () => {
    const buildCalls: unknown[] = [];
    const h = harness([
      resp([toolCall('build', { preview: true }, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async (opts) => { buildCalls.push(opts); return cleanReport(); } });
    await runCodegenLoop(INITIAL, h.deps);
    expect(buildCalls).toEqual([{ preview: true }]);
  });

  it('a failed bundle step is a FIX round, and a repeated build call is EXEMPT from the loop detector', async () => {
    // fix-then-rebuild legitimately repeats `build` — the identical-call detector must
    // not abort the turn on the second call.
    const bundleFailed = cleanReport({
      bundle: { ran: true, ok: false, tail: 'Rollup failed: src/App.vue (3:7)' },
      preview: { refreshed: false, why: 'bundle failed — there is no dist to refresh the preview from' },
    });
    const reports: BuildReport[] = [bundleFailed, cleanReport()];
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP }, 'w1')]),
      resp([toolCall('build', {}, 'b2')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async () => reports.shift()! });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    const builds = r.toolCalls.filter((t) => t.name === 'build');
    expect(builds).toHaveLength(2);
    expect(builds[0]!.result).toEqual(bundleFailed);
    expect(builds[1]!.result).toEqual(cleanReport());
    // The failed bundle dropped the NEXT round into fix params (sawError → fixMode);
    // per-round: the clean write round after it restores generateParams.
    expect(h.paramsSeen[1]).toEqual(DEFAULT_LOOP_CONFIG.fixParams);
    expect(h.paramsSeen[2]).toEqual(DEFAULT_LOOP_CONFIG.generateParams);
  });

  it('m2a on build: malformed arguments JSON → captured tool error, the box never starts', async () => {
    const buildCalls: unknown[] = [];
    const h = harness([
      resp([malformedToolCall('build', '{preview: yes')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async () => { buildCalls.push(1); return cleanReport(); } });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(buildCalls).toEqual([]); // never dispatched
    expect(r.toolCalls[0].error).toContain('malformed tool arguments');
  });

  it('typia-rejected build args → captured tool error, the box never starts', async () => {
    const buildCalls: unknown[] = [];
    const h = harness([
      resp([toolCall('build', { preview: 'yes' }, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {
      build: async () => { buildCalls.push(1); return cleanReport(); },
      validateToolArgs: async (name) => (name === 'build'
        ? { ok: false, error: 'invalid build args — $input.preview: expected (boolean | undefined)' }
        : { ok: true }),
    });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(buildCalls).toEqual([]); // never dispatched
    expect(r.toolCalls[0].error).toContain('invalid build args');
  });

  it('a THROWING deps.build is captured as a container-step failure — never an uncaught crash', async () => {
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([], { content: 'giving up' }),
    ], { build: async () => { throw new Error('capnweb session tore'); } });
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('no-tool-calls'); // the turn survived the throw
    const rec = r.toolCalls.find((t) => t.name === 'build');
    // The job never ran: `container` failed with the thrown message, and every other
    // step honestly says it did not run (the shape's own rule — never absent).
    expect(rec?.result).toEqual({
      container: { ran: true, ok: false, tail: 'capnweb session tore' },
      ontology: { ran: false, why: 'the build job did not run' },
      typeCheck: { ran: false, checked: [], findings: [] },
      bundle: { ran: false, why: 'the build job did not run' },
      preview: { refreshed: false, why: 'the build job did not run' },
    });
  });
});

describe('Phase 2 — Workers-AI REST envelope unwrap feeds parseModelTurn', () => {
  it('unwraps `.result` so a wrapped REST envelope parses identically to the binding shape', () => {
    const inner = resp([toolCall('writeSource', { path: 'App.vue', source: 'x' })]);
    const restEnvelope = { result: inner, success: true, errors: [], messages: [] };

    // unwrap === the inner binding-shape value
    expect(unwrapWorkersAiRest(restEnvelope)).toEqual(inner);
    // and it parses to the same tool_call the binding path would
    const fromRest = parseModelTurn(unwrapWorkersAiRest(restEnvelope));
    const fromBinding = parseModelTurn(inner);
    expect(fromRest.toolCalls).toEqual(fromBinding.toolCalls);
    expect(fromRest.toolCalls[0]).toMatchObject({ name: 'writeSource' });
  });

  it('passes through an already-unwrapped (AI-Gateway provider-native) response', () => {
    const inner = resp([toolCall('writeSource', { path: 'A.vue', source: 'y' })]);
    expect(unwrapWorkersAiRest(inner)).toEqual(inner); // no `success` key → returned as-is
  });

  it('throws on `success: false` rather than returning an undefined result (no silent empty turn)', () => {
    expect(() => unwrapWorkersAiRest({ result: null, success: false, errors: [{ message: 'boom' }] }))
      .toThrow(/success=false/);
  });
});

// ─── The preview decision (every arm — pure, exported for exactly this) ─────────
import { decidePreview } from '../../../src/galaxy';

describe('decidePreview — refresh-on-clean by default; the model may override; a failed bundle is structural', () => {
  it('clean build → refreshes by default', () => {
    expect(decidePreview(cleanReport())).toEqual({ refreshed: true, why: 'clean build' });
  });

  it('findings → withheld by default; override true refreshes; override false declines a CLEAN build', () => {
    const withFindings = findingsReport(['src/App.vue(1,1): error TS2322: x']);
    expect(decidePreview(withFindings).refreshed).toBe(false);
    expect(decidePreview(withFindings).why).toContain('type findings');
    expect(decidePreview(withFindings, true)).toEqual({ refreshed: true, why: "refreshed on the model's override" });
    expect(decidePreview(cleanReport(), false)).toEqual({ refreshed: false, why: 'the model declined to refresh the preview' });
  });

  it('a failed ontology step withholds by default (override still wins)', () => {
    const ontologyFailed = cleanReport({ ontology: { ran: true, ok: false, tail: 'boom' } });
    expect(decidePreview(ontologyFailed).refreshed).toBe(false);
    expect(decidePreview(ontologyFailed).why).toContain('ontology compile failed');
    expect(decidePreview(ontologyFailed, true).refreshed).toBe(true);
  });

  it('no dist is STRUCTURAL — even override:true cannot refresh from a failed or never-run bundle', () => {
    const bundleFailed = cleanReport({ bundle: { ran: true, ok: false, tail: 'rolldown died' } });
    expect(decidePreview(bundleFailed, true)).toEqual({ refreshed: false, why: 'bundle failed — there is no dist to refresh the preview from' });
    const bundleSkipped = cleanReport({ bundle: { ran: false, why: 'the build job did not run' } });
    const skipped = decidePreview(bundleSkipped, true);
    expect(skipped.refreshed).toBe(false);
    expect(skipped.why).toContain('bundle did not run');
  });
});
