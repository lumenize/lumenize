/**
 * Phase 2–3 — the self-correcting codegen loop (tasks/archive/nebula-codegen-loop.md).
 *
 * Two layers, both container-free, no AI binding (the `dev-studio` project):
 *  - **Loop-logic unit tests** drive `runCodegenLoop` directly with injected fake
 *    deps + a synthetic model script — the bound (D4), loop-detection (D4, each
 *    operand mutated independently), the m2 malformed-envelope cases, path safety
 *    (D5a), and the user-layer error-tail round-trip (D1/D7/D8).
 *  - **DevStudio integration tests** go through the real node (the `DevStudioLoopProbe`
 *    whose `callModel` replays a script): the real typia arg-validator facet (D5), the
 *    recorder wiring (m4), and the **secure-by-default D2 guard** — a hostile ontology
 *    `write_file` compiles but the `.dev` Star is never installed/wiped.
 *
 * @see tasks/archive/nebula-codegen-loop.md § Phases 2–3
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import {
  runCodegenLoop,
  assembleCodegenPrompt,
  parseModelTurn,
  DEFAULT_LOOP_CONFIG,
  type CodegenLoopDeps,
  type CodegenLoopConfig,
  type ChatMessage,
  type ModelParams,
} from '../../../src/codegen-loop';
import { unwrapWorkersAiRest } from '../../../src/dev-studio';

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
    ...over,
  };
  return { deps, writes, paramsSeen, messagesSeen };
}

describe('Phase 2 — loop driver: stop conditions (D4)', () => {
  it('write_file (clean) then mark_complete → stop=complete, file written once, gate ok', async () => {
    const h = harness([
      resp([toolCall('write_file', { path: 'src/App.vue', content: GOOD_APP })]),
      resp([toolCall('mark_complete', {})]),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    expect(h.writes).toEqual([{ path: 'src/App.vue', content: GOOD_APP }]);
    expect(r.lastGate).toEqual({ ok: true });
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
    expect(r.lastGate).toBeUndefined(); // compile gate never reached after the throw
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

describe('Phase 2 — the compile error-tail round-trips into the next round (D1/D7/D8)', () => {
  it('a failing ontology write pushes its error-tail into the next round\'s user layer', async () => {
    const h = harness([
      resp([toolCall('write_file', { path: 'src/ontology.d.ts', content: BROKEN_ONTOLOGY })]),
      resp([toolCall('mark_complete', {})]),
    ]);
    const r = await runCodegenLoop(INITIAL, h.deps);
    expect(r.stop).toBe('complete');
    const tail = r.lastGate?.errorTail;
    expect(tail).toBeTruthy();
    // The round-2 transcript (what the model saw next) carries the error-tail in a
    // user-role message — the self-correction signal.
    const round2 = h.messagesSeen[1];
    const userFeedback = round2.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(userFeedback).toContain('did not compile');
    expect(userFeedback).toContain(tail!);
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

  it('per-call params: round 1 uses generate params; the round after a compile error uses fix params (D6)', async () => {
    const h = harness([
      resp([toolCall('write_file', { path: 'src/App.vue', content: '<template><p>{{ x.}}</p></template>' })]), // broken
      resp([toolCall('mark_complete', {})]),
    ]);
    const cfg: CodegenLoopConfig = {
      maxToolDepth: 8,
      generateParams: { temperature: 0.7, max_tokens: 100 },
      fixParams: { temperature: 0.1, max_tokens: 200 },
    };
    await runCodegenLoop(INITIAL, h.deps, cfg);
    expect(h.paramsSeen[0]).toEqual(cfg.generateParams);
    expect(h.paramsSeen[1]).toEqual(cfg.fixParams); // dropped to fix after the error
  });
});

describe('Phase 2 — D2 structural guard: the loop names no install/wipe sink', () => {
  it('runCodegenLoop references none of the Star/DevContainer install/wipe symbols', () => {
    const src = runCodegenLoop.toString();
    for (const forbidden of [
      'resetDevData', 'setOntology', 'compileAndInstallOntology',
      'applyOntologyChange', 'setAppVersion', 'applyChanges',
      'STAR_BINDING', 'DEV_CONTAINER',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

// ─── DevStudio integration layer (real node via the probe + envelopes) ───

const OID_RE = /^[0-9a-f]{40}$/;
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;
const VALID_ONTOLOGY = `interface Todo { title: string; done: boolean; }`;

// Direct in-DO call — returns the method's result. `runLoopForTest` returns its LoopResult this way:
// the loop's own recordTurn fire-and-forget is caught non-fatally when there's no callContext, so
// the result still comes back. (Where the LANDED turn is the assertion — m4 below — we drive through
// the real receive path via `fire` so recordTurn carries scope.)
const inDO = (binding: any, instance: string, fn: (inst: any) => unknown) =>
  (runInDurableObject as any)(binding.getByName(instance), fn);

// Fire through the REAL early-ack receive path (claims in the envelope) so cross-DO effects — here
// the loop's recordTurn → {u}.{g} Galaxy (aud {u}.{g}.dev, covered by the Galaxy's `{u}.{g}.*`) —
// propagate callContext. Observe the durable effect with `inDO` + vi.waitFor.
const fire = (binding: any, bindingName: string, instance: string, method: string, args: unknown[] = []) =>
  binding.getByName(instance).__executeOperation({
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
    // `authScopePattern` is required — `requireAdmin` confines the admin bit to the callee node, and
    // the denial on these 3-arg calls is SILENT (a missing downstream effect, not an error).
    // `{universe}.*` mirrors the real caller: a universe founder reaching its `.dev` Star.
    callContext: { callChain: [], state: {}, originAuth: { sub: 'admin', claims: { aud: instance, access: { admin: true, authScopePattern: `${instance.split('.')[0]}.*` } } } } as any,
    metadata: { callee: { type: 'LumenizeDO', bindingName, instanceName: instance } },
  });
const tc = toolCall;
const aiResp = resp;

describe('Phase 2/3 integration — real DevStudio loop (probe replays a script)', () => {
  it('clean write_file then mark_complete: commits the file + completes', async () => {
    const dev = uniqueDevScope();
    // The loop is LOCAL (compile/validate/git in-DO); its recordTurn fire is non-fatal without a
    // callContext, so a direct in-DO call gets the LoopResult. (The landed turn is m4 below.)
    const { result } = (await inDO(env.DEV_STUDIO, dev, (s) => s.runLoopForTest(
      'build a todo app',
      [aiResp([tc('write_file', { path: 'src/App.vue', content: GOOD_APP })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.stop).toBe('complete');
    expect(result.appliedPaths).toEqual(['src/App.vue']);
    // The real Workspace holds the committed file.
    expect(await inDO(env.DEV_STUDIO, dev, (s) => s.readSource('src/App.vue'))).toBe(GOOD_APP);
  });

  it('D5: a non-string path is rejected by the REAL typia validator facet (never written)', async () => {
    const dev = uniqueDevScope();
    const { result } = (await inDO(env.DEV_STUDIO, dev, (s) => s.runLoopForTest(
      'build',
      [aiResp([tc('write_file', { path: 123, content: 'x' })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.toolCalls[0].error).toContain('invalid write_file args');
    // Capable-of-failing: nothing landed in the Workspace.
    const tree = (await inDO(env.DEV_STUDIO, dev, (s) => s.getSourceTree())) as any;
    expect(tree.files.length).toBe(0);
  });

  it('D2 SECURE-BY-DEFAULT: a hostile ontology write_file compiles but NEVER installs/wipes the .dev Star', async () => {
    const dev = uniqueDevScope();
    const { result } = (await inDO(env.DEV_STUDIO, dev, (s) => s.runLoopForTest(
      'add a Todo type',
      [aiResp([tc('write_file', { path: 'src/ontology.d.ts', content: VALID_ONTOLOGY })]), aiResp([tc('mark_complete', {})])],
    ))) as any;
    expect(result.stop).toBe('complete');
    // The ontology was written to the Workspace and compiled clean…
    expect(await inDO(env.DEV_STUDIO, dev, (s) => s.readSource('src/ontology.d.ts'))).toBe(VALID_ONTOLOGY);
    expect(result.lastGate).toEqual({ ok: true });
    // …but it was NEVER installed on the .dev Star (no setOntology / compileAndInstallOntology) and
    // nothing was wiped. Capable-of-failing: an install would leave a version in the Star's index.
    expect(await inDO(env.STAR, dev, (s) => s.inspectOntologyIndex())).toEqual([]);
  });

  it('m4: the loop records a TurnRecord (toolCalls non-empty; error/validate reflect the final gate); getTurns round-trips it', async () => {
    const dev = uniqueDevScope();
    const galaxy = dev.split('.').slice(0, 2).join('.'); // {u}.{g}
    // Drive through the REAL receive path so the loop's fire-and-forget recordTurn carries scope to
    // the Galaxy; then poll the Galaxy (its durable effect) until the turn lands.
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'runLoopForTest', [
      'add a Todo type',
      [aiResp([tc('write_file', { path: 'src/ontology.d.ts', content: VALID_ONTOLOGY })]), aiResp([tc('mark_complete', {})])],
    ]);
    await vi.waitFor(async () => {
      const turns = (await inDO(env.GALAXY, galaxy, (g) => g.getTurns({}))) as any[];
      expect(turns.length).toBe(1);
      const t = turns[0];
      expect(t.toolCalls.length).toBeGreaterThan(0);
      expect(t.toolCalls.some((c: any) => c.name === 'write_file')).toBe(true);
      expect(t.validate).toEqual({ ok: true }); // final gate result
      expect(t.error).toBeUndefined();           // clean finish → no error tail
      expect(t.applied).toBe(true);
      // The default 1s waitFor loses to the full-suite parallel load — the codegen turn plus the
      // cross-DO getTurns roundtrip runs long when 85 files share the box. Raising it does NOT
      // weaken the assertion: a turn that never lands still reds, just 15s later.
    }, { timeout: 15000 });
  });

  it('m4: a turn that ENDS on a failing gate persists validate.ok=false + a populated error tail (getTurns)', async () => {
    const dev = uniqueDevScope();
    const galaxy = dev.split('.').slice(0, 2).join('.');
    // A type-broken <script setup> passes Pass-1 transpile but fails Pass-2; the
    // model then marks complete, so the FINAL gate is the failing one.
    const BROKEN_APP = `<script setup lang="ts">
const n: number = 'not a number';
</script>
<template><p>{{ n }}</p></template>`;
    await fire(env.DEV_STUDIO, 'DEV_STUDIO', dev, 'runLoopForTest', [
      'build',
      [aiResp([tc('write_file', { path: 'src/App.vue', content: BROKEN_APP })]), aiResp([tc('mark_complete', {})])],
    ]);
    await vi.waitFor(async () => {
      const turns = (await inDO(env.GALAXY, galaxy, (g) => g.getTurns({}))) as any[];
      expect(turns.length).toBe(1);
      const t = turns[0];
      // Exercises the !ok branch of the error-mapping (dev-studio.ts runCodegenTurn):
      // validate carries {ok:false,errorTail}; error is the SAME sanitized tail.
      expect(t.validate.ok).toBe(false);
      expect(t.error).toBeTruthy();
      expect(t.error).toBe(t.validate.errorTail);
      expect(t.applied).toBe(true); // the broken file was still written to the Workspace
    }, { timeout: 15000 });         // see the sibling m4 above — default 1s loses to full-suite load
  });

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
