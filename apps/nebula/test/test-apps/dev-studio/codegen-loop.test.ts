/**
 * Phase 2–3 — the self-correcting codegen loop (tasks/archive/nebula-codegen-loop.md;
 * the per-write compile died with tasks/nebula-move-compilers-out-of-the-worker.md —
 * a `write_file` is a pure write, and the container `build`'s per-step report is the
 * self-correction signal).
 *
 * Two layers, both container-free, no AI binding (the `dev-studio` project):
 *  - **Loop-logic unit tests** drive `runCodegenLoop` directly with injected fake
 *    deps + a synthetic model script — the bound (D4), loop-detection (D4, each
 *    operand mutated independently), the m2 malformed-envelope cases, path safety
 *    (D5a), and the user-layer build-report feedback round-trip (D1/D7/D8's successor).
 *  - **Galaxy integration tests** go through the real node (the `GalaxyLoopProbe`
 *    whose `callModel` replays a script): the real typia arg-validator facet (D5) and
 *    the **secure-by-default D2 guard** — a written ontology never installs/wipes the
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
  DEFAULT_LOOP_CONFIG,
  type BuildReport,
  type CodegenLoopDeps,
  type CodegenLoopConfig,
  type ChatMessage,
  type ModelParams,
} from '../../../src/codegen-loop';
import { unwrapWorkersAiRest } from '../../../src/galaxy';

/** A clean build report, shaped exactly as the host composes it. */
const cleanReport = (over: Partial<BuildReport> = {}): BuildReport => ({
  container: { ran: true, ok: true },
  ontology: { ran: false, why: 'no ontology change (host passed no version)' },
  typeCheck: { ran: true, checked: ['src/App.vue'], findings: [] },
  bundle: { ran: true, ok: true },
  publish: { done: true, why: 'clean build' },
  ...over,
});

/** A report carrying type findings (advisory — bundle still ok, dist produced). */
const findingsReport = (findings: string[]): BuildReport => cleanReport({
  typeCheck: { ran: true, checked: ['src/App.vue'], findings },
  publish: { done: false, why: 'type findings — publish withheld by default (the model may override)' },
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
  paramsSeen: ModelParams[];
  messagesSeen: ChatMessage[][];
}
function harness(script: unknown[], over: Partial<CodegenLoopDeps> = {}): Harness {
  let i = 0;
  const writes: { path: string; content: string }[] = [];
  const paramsSeen: ModelParams[] = [];
  const messagesSeen: ChatMessage[][] = [];
  const deps: CodegenLoopDeps = {
    callModel: async (messages, params) => {
      paramsSeen.push(params);
      messagesSeen.push(messages.map((m) => ({ ...m })));
      const r = script[i++];
      if (r === undefined) throw new Error('fake model script exhausted');
      return r;
    },
    writeFile: async (path, content) => { writes.push({ path, content }); return { oid: `oid${writes.length}`, path }; },
    validateToolArgs: async () => ({ ok: true }),
    build: async () => cleanReport(),
    ...over,
  };
  return { deps, writes, paramsSeen, messagesSeen };
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

  it('a writeFile that THROWS is captured (not an uncaught crash); loop continues', async () => {
    const h = harness(
      [
        resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP })]),
        resp([toolCall('mark_complete', {})]),
      ],
      { writeFile: async () => { throw new Error('disk boom'); } },
    );
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(r.toolCalls[0].error).toContain('disk boom');
    expect(r.appliedPaths).toEqual([]); // a throwing write never counts as applied
  });

  it('invalid tool-call args (typia reject) → tool error, never dispatched', async () => {
    const h = harness(
      [
        resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP })]),
        resp([toolCall('mark_complete', {})]),
      ],
      { validateToolArgs: async () => ({ ok: false, error: 'bad shape' }) },
    );
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(h.writes).toEqual([]);
    expect(r.toolCalls[0].error).toBe('bad shape');
  });
});

describe('Phase 2 — path safety (D5a) before writeSource', () => {
  it.each([
    ['../escape', '..'],
    ['/abs/path', 'Absolute'],
  ])('write_file(%s) is rejected as a tool error and never reaches writeFile', async (path, needle) => {
    const h = harness([
      resp([toolCall('write_file', { path, content: 'x' })]),
      resp([toolCall('mark_complete', {})]),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(h.writes).toEqual([]); // never reached the Workspace
    expect(r.toolCalls[0].error).toContain(needle);
  });
});

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
        publish: { done: false, why: 'ontology compile failed — publish withheld by default' },
      }),
    });
    const r = await runCodegenLoop(INITIAL, h.deps);
    const round2 = h.messagesSeen[1];
    const userFeedback = round2.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(userFeedback).toContain('ontology step failed');
    expect(userFeedback).toContain('starts with "_"');
    expect(r.stop).toBe('complete');
  });

  it('a failed container step round-trips its tail the same way', async () => {
    const h = harness([
      resp([toolCall('build', {}, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {
      build: async () => cleanReport({
        container: { ran: true, ok: false, tail: 'build job killed (failed, exit 137) — likely the 180000 ms build timeout' },
        ontology: { ran: false, why: 'the build job did not run' },
        typeCheck: { ran: false, checked: [], findings: [] },
        bundle: { ran: false, why: 'the build job did not run' },
        publish: { done: false, why: 'the build job did not run' },
      }),
    });
    const r = await runCodegenLoop(INITIAL, h.deps);
    const round2 = h.messagesSeen[1];
    const userFeedback = round2.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(userFeedback).toContain('container step failed');
    expect(userFeedback).toContain('build timeout');
    expect(r.stop).toBe('complete');
  });
});

describe('Phase 3 — prompt assembly (D7) + per-call params (D6)', () => {
  it('assembleCodegenPrompt: ontology in the system block; source + request in the user block', () => {
    const { system, user } = assembleCodegenPrompt({
      systemBundles: ['BUNDLE-A'],
      ontologyDts: 'interface Todo { title: string }',
      userRequest: 'add a priority field',
      currentSource: '<template>X</template>',
    });
    expect(system.role).toBe('system');
    expect(system.content).toContain('BUNDLE-A');
    expect(system.content).toContain('interface Todo { title: string }');
    expect(system.content).not.toContain('add a priority field');
    expect(user.role).toBe('user');
    expect(user.content).toContain('add a priority field');
    expect(user.content).toContain('<template>X</template>');
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
  // tasks/nebula-galaxy-collapse-and-chat.md.)

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
    expect(toolMsg?.content).toContain('"publish"');
    expect(toolMsg?.content).toContain('"why":"clean build"');
  });

  it('the model\'s publish override rides BuildArgs through to deps.build', async () => {
    const buildCalls: unknown[] = [];
    const h = harness([
      resp([toolCall('build', { publish: true }, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], { build: async (opts) => { buildCalls.push(opts); return cleanReport(); } });
    await runCodegenLoop(INITIAL, h.deps);
    expect(buildCalls).toEqual([{ publish: true }]);
  });

  it('a failed bundle step is a FIX round, and a repeated build call is EXEMPT from the loop detector', async () => {
    // fix-then-rebuild legitimately repeats `build` — the identical-call detector must
    // not abort the turn on the second call.
    const bundleFailed = cleanReport({
      bundle: { ran: true, ok: false, tail: 'Rollup failed: src/App.vue (3:7)' },
      publish: { done: false, why: 'bundle failed — there is no dist to publish' },
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
      resp([malformedToolCall('build', '{publish: yes')]),
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
      resp([toolCall('build', { publish: 'yes' }, 'b1')]),
      resp([toolCall('mark_complete', {}, 'c1')]),
    ], {
      build: async () => { buildCalls.push(1); return cleanReport(); },
      validateToolArgs: async () => ({ ok: false, error: 'invalid build args — $input.publish: expected (boolean | undefined)' }),
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
      publish: { done: false, why: 'the build job did not run' },
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

// ─── The publish decision (every arm — pure, exported for exactly this) ─────────
import { decidePublish } from '../../../src/galaxy';

describe('decidePublish — default publish-on-clean; the model may override; a failed bundle is structural', () => {
  it('clean build → publishes by default', () => {
    expect(decidePublish(cleanReport())).toEqual({ done: true, why: 'clean build' });
  });

  it('findings → withheld by default; override true publishes; override false declines a CLEAN build', () => {
    const withFindings = findingsReport(['src/App.vue(1,1): error TS2322: x']);
    expect(decidePublish(withFindings).done).toBe(false);
    expect(decidePublish(withFindings).why).toContain('type findings');
    expect(decidePublish(withFindings, true)).toEqual({ done: true, why: "published on the model's override" });
    expect(decidePublish(cleanReport(), false)).toEqual({ done: false, why: 'the model declined to publish' });
  });

  it('a failed ontology step withholds by default (override still wins)', () => {
    const ontologyFailed = cleanReport({ ontology: { ran: true, ok: false, tail: 'boom' } });
    expect(decidePublish(ontologyFailed).done).toBe(false);
    expect(decidePublish(ontologyFailed).why).toContain('ontology compile failed');
    expect(decidePublish(ontologyFailed, true).done).toBe(true);
  });

  it('no dist is STRUCTURAL — even override:true cannot publish a failed or never-run bundle', () => {
    const bundleFailed = cleanReport({ bundle: { ran: true, ok: false, tail: 'rolldown died' } });
    expect(decidePublish(bundleFailed, true)).toEqual({ done: false, why: 'bundle failed — there is no dist to publish' });
    const bundleSkipped = cleanReport({ bundle: { ran: false, why: 'the build job did not run' } });
    const skipped = decidePublish(bundleSkipped, true);
    expect(skipped.done).toBe(false);
    expect(skipped.why).toContain('bundle did not run');
  });
});
