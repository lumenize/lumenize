/**
 * The loop holds nothing between rounds. Before every step it reads the turn's rounds from a store
 * and works out where the turn stands, and it writes each reply and each call's outcome there as
 * they arrive, so a second invocation on the same store continues the turn.
 *
 * Loop-level, with a scripted model and fake tools, in the vitest-plugin lane: what these compare
 * is what the loop hands the model at each round, which no running system shows, and which the
 * model's own choices would decide in `/live`. The Galaxy's own store, `Round` Resources, is
 * driven by `rounds-as-they-land`.
 */
import { describe, it, expect } from 'vitest';
import {
  runCodegenLoop,
  rebuildTurn,
  memoryRoundStore,
  memoryBlobs,
  assembleCodegenPrompt,
  DEFAULT_LOOP_CONFIG,
  INTERRUPTED_CALL_ERROR,
  INTERRUPTED_ROUND_NOTE,
  type BuildReport,
  type CodegenLoopConfig,
  type CodegenLoopDeps,
  type ChatMessage,
  type ModelParams,
  type RoundStore,
  type StoredRound,
} from '../../../src/codegen-loop';

const INITIAL = assembleCodegenPrompt({ systemBundles: ['sys'], userRequest: 'build a todo app' });
const PROMPT = [INITIAL.system, INITIAL.user];

const call = (name: string, args: unknown, id: string) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const malformed = (name: string, id: string) => ({ id, type: 'function', function: { name, arguments: '{ not json' } });
const resp = (calls: unknown[], content = '', reasoning = '') =>
  ({ choices: [{ message: { content, reasoning_content: reasoning, tool_calls: calls } }] });
/** A script entry that makes the model call throw. */
const THROWS = { throws: 'Workers AI REST 429 at /ai/run/x' };

const report = (over: Partial<BuildReport> = {}): BuildReport => ({
  container: { ran: true, ok: true },
  ontology: { ran: false, why: 'no ontology change' },
  typeCheck: { ran: true, checked: ['src/App.vue'], findings: [] },
  bundle: { ran: true, ok: true },
  preview: { refreshed: true, why: 'clean build' },
  ...over,
});
const findings = report({ typeCheck: { ran: true, checked: ['src/App.vue'], findings: ['src/App.vue(1,1): error TS2339'] } });
const noBox = report({ container: { ran: true, ok: false, tail: 'no build container attached' } });

/** A tool error the Galaxy throws when the post a turn took up has changed under it. */
const moved = (): Error => Object.assign(new Error('moved on'), { name: 'ResourceMovedOnError' });

interface World {
  files: Map<string, string>;
  writes: string[];
  builds: number;
  /** What each build answers, in order, then a clean report. */
  buildScript: BuildReport[];
  /** Paths whose write throws that the post moved. */
  movedOn: Set<string>;
}
const world = (seed: Record<string, string> = {}): World =>
  ({ files: new Map(Object.entries(seed)), writes: [], builds: 0, buildScript: [], movedOn: new Set() });

/** The deps a turn runs with, over one shared world, store and blob store. */
function depsOf(w: World, store: RoundStore, blobs = memoryBlobs(), callModel: CodegenLoopDeps['callModel']): CodegenLoopDeps {
  return {
    callModel,
    rounds: store,
    blobs,
    validateToolArgs: async () => ({ ok: true }),
    actsFor: () => ({ post: 'post-1', claims: { sub: 'austen', profileId: 'p-austen' } }),
    tools: {
      read_file: async (path) => {
        const c = w.files.get(path);
        if (c === undefined) throw new Error(`no such file: ${path}`);
        return c;
      },
      write_file: async (path, content) => {
        if (w.movedOn.has(path)) throw moved();
        w.writes.push(path);
        w.files.set(path, content);
        return { oid: `commit-${w.writes.length}`, path };
      },
      edit_file: async (path) => ({ oid: 'commit-edit', path }),
      build: async () => { w.builds++; return w.buildScript.shift() ?? report(); },
      invite: async (email) => ({ invited: email, as: 'collaborator' as const, note: 'sent' }),
      run_in_tab: () => {},
    },
  };
}

type Seen = Array<[ChatMessage[], ModelParams]>;
const clone = <T>(v: T): T => structuredClone(v);

/** The model, answering `script` in order; a `THROWS` entry throws. */
function model(script: unknown[], seen: Seen, from: { i: number }): CodegenLoopDeps['callModel'] {
  return async (messages, params) => {
    seen.push([clone(messages), clone(params)]);
    const next = script[from.i++];
    if (next === undefined) throw new Error('script exhausted');
    if ((next as typeof THROWS).throws) throw new Error((next as typeof THROWS).throws);
    return next;
  };
}

/** The turn run straight through, in one invocation. */
async function straight(script: unknown[], w: World, config: CodegenLoopConfig = DEFAULT_LOOP_CONFIG, store: RoundStore = memoryRoundStore()) {
  const seen: Seen = [];
  const result = await runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model(script, seen, { i: 0 })), config);
  return { seen, result };
}

const PAUSE = 'paused between rounds';
/** The same turn, as a fresh invocation per round: each answers one model call and stops at the next. */
async function perRound(script: unknown[], w: World, config: CodegenLoopConfig = DEFAULT_LOOP_CONFIG, store: RoundStore = memoryRoundStore()) {
  const seen: Seen = [];
  const blobs = memoryBlobs();
  const from = { i: 0 };
  for (let invocations = 0; invocations < 100; invocations++) {
    let answered = false;
    const once: CodegenLoopDeps['callModel'] = async (messages, params) => {
      if (answered) throw new Error(PAUSE);
      answered = true;
      return model(script, seen, from)(messages, params);
    };
    const result = await runCodegenLoop(INITIAL, depsOf(w, store, blobs, once), config);
    if (!(result.stop === 'error' && result.detail?.includes(PAUSE))) return { seen, result };
  }
  throw new Error('the turn never ended');
}

/** One script per way a run of the loop stops on its own. `interrupted` needs a wake, which the
 *  woken tests below and `turn-wake.test.ts` drive, and `deadline` is our own code's, never the loop's. */
const SCRIPTS: Array<{ stop: string; script: unknown[]; seed?: Record<string, string>; config?: CodegenLoopConfig; setup?: (w: World) => void; store?: () => RoundStore }> = [
  {
    stop: 'complete',
    seed: { 'docs/vision.md': '# Vision\nA wishlist app.' },
    // A read, a write, a build with findings and its feedback, an unparseable call, a fix, the end.
    script: [
      resp([call('read_file', { path: 'docs/vision.md' }, 'r1')], 'reading'),
      resp([call('write_file', { path: 'src/App.vue', content: 'v1' }, 'w1'), call('build', {}, 'b1')], 'writing'),
      resp([malformed('write_file', 'w2')], 'fixing'),
      resp([call('write_file', { path: 'src/App.vue', content: 'v2' }, 'w3'), call('build', {}, 'b2')], 'fixed'),
      resp([call('mark_complete', { answers: ['post-2'] }, 'c1')], 'done'),
    ],
    setup: (w) => { w.buildScript = [findings]; },
  },
  {
    stop: 'max-depth',
    config: { ...DEFAULT_LOOP_CONFIG, maxToolDepth: 3 },
    script: [0, 1, 2, 3].map((n) => resp([call('write_file', { path: 'src/App.vue', content: `round ${n}` }, `w${n}`)], `round ${n}`)),
  },
  {
    stop: 'loop-detected',
    script: [
      resp([call('write_file', { path: 'src/App.vue', content: 'same' }, 'w1')], 'one'),
      resp([call('read_file', { path: 'src/App.vue' }, 'r1')], 'two'),
      resp([call('write_file', { path: 'src/App.vue', content: 'same' }, 'w2')], 'three'),
    ],
  },
  {
    stop: 'loop-detected',
    script: [
      resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1')], 'thinking…'),
      resp([call('write_file', { path: 'b.vue', content: 'b' }, 'w2')], 'thinking…'),
    ],
  },
  {
    stop: 'no-tool-calls',
    script: [resp([malformed('write_file', 'w1')], 'oops'), resp([], 'Nothing more to change.')],
  },
  {
    stop: 'build-unavailable',
    script: [resp([call('build', {}, 'b1')], 'building'), resp([call('build', {}, 'b2')], 'again'), resp([call('mark_complete', {}, 'c1')])],
    setup: (w) => { w.buildScript = [noBox, noBox]; },
  },
  {
    stop: 'post-moved',
    script: [resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1')], 'one'), resp([call('write_file', { path: 'gone.vue', content: 'x' }, 'w2')], 'two')],
    setup: (w) => { w.movedOn.add('gone.vue'); },
  },
  {
    stop: 'error',
    script: [resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1')], 'one'), THROWS],
  },
  {
    stop: 'conflict',
    script: [resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), call('write_file', { path: 'b.vue', content: 'b' }, 'w2')], 'one'), resp([call('mark_complete', {}, 'c1')])],
    // Another writer changes the round between its two calls.
    store: () => {
      const inner = memoryRoundStore();
      let updates = 0;
      return { ...inner, update: async (id, round, version) => (++updates === 2 ? 'conflict' : inner.update(id, round, version)) };
    },
  },
];

describe('a turn run round by round from its store is the turn run straight through', () => {
  // MUTATIONS: keep the identical-call detector's memory in a local, or the fix params' switch,
  // and the per-round run misses a repeat, or calls with the generate params, where the straight
  // run does not.
  it.each(SCRIPTS.map((s, i) => [`${s.stop} (${i})`, s]))('%s: the same messages and params at every round', async (_name, s) => {
    const w1 = world(s.seed); s.setup?.(w1);
    const w2 = world(s.seed); s.setup?.(w2);
    const one = await straight(s.script, w1, s.config, s.store?.());
    const many = await perRound(s.script, w2, s.config, s.store?.());
    expect(one.result.stop).toBe(s.stop);
    expect(many.result.stop).toBe(s.stop);
    expect(many.seen).toEqual(one.seen);
    expect(many.result.messages).toEqual(one.result.messages);
    expect(many.result.toolCalls).toEqual(one.result.toolCalls);
    expect([many.result.rounds, many.result.appliedPaths, many.result.answers]).toEqual([one.result.rounds, one.result.appliedPaths, one.result.answers]);
    expect(w2.writes).toEqual(w1.writes);
  });

  it('the complete script\'s rounds carry what the model was shown, read back from the blob store', async () => {
    const s = SCRIPTS[0]!;
    const w = world(s.seed); s.setup?.(w);
    const { seen } = await perRound(s.script, w);
    // Round 2 saw the file's content, though the round records only its blob id.
    expect(seen[1]![0].find((m) => m.role === 'tool')?.content).toContain('A wishlist app.');
    // Round 3 saw the build's findings and is a fix round.
    expect(seen[2]![0].filter((m) => m.role === 'user').at(-1)?.content).toContain('The build reported problems');
    expect(seen[2]![1]).toEqual(DEFAULT_LOOP_CONFIG.fixParams);
  });
});

/** The stored rounds of a turn run on `store`, by index. */
async function rounds(store: RoundStore): Promise<StoredRound[]> {
  return (await store.read()).map((s) => s.round).sort((a, b) => a.index - b.index);
}

describe('a stop that lands mid-round', () => {
  const STOPPERS: Array<[string, unknown[], (w: World) => void]> = [
    ['mark_complete', [resp([call('write_file', { path: 'b.vue', content: 'b' }, 'w1'), call('mark_complete', {}, 'c1'), call('write_file', { path: 'c.vue', content: 'c' }, 'w2')])], () => {}],
    ['a repeated call', [
      resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w0')], 'first'),
      resp([call('write_file', { path: 'b.vue', content: 'b' }, 'w1'), call('write_file', { path: 'a.vue', content: 'a' }, 'w2'), call('write_file', { path: 'c.vue', content: 'c' }, 'w3')], 'second'),
    ], () => {}],
    ['a second failed container step', [
      resp([call('build', {}, 'b0')], 'first'),
      resp([call('write_file', { path: 'b.vue', content: 'b' }, 'w1'), call('build', {}, 'b1'), call('write_file', { path: 'c.vue', content: 'c' }, 'w2')], 'second'),
    ], (w) => { w.buildScript = [noBox, noBox]; }],
    ['a post that moved on', [resp([call('write_file', { path: 'b.vue', content: 'b' }, 'w1'), call('write_file', { path: 'gone.vue', content: 'x' }, 'w2'), call('write_file', { path: 'c.vue', content: 'c' }, 'w3')])], (w) => { w.movedOn.add('gone.vue'); }],
  ];

  // MUTATION: write every result only as the round ends, and the dispatched call before the stop
  // holds nothing.
  it.each(STOPPERS)('at %s: each call before it holds its outcome and claims, and each after holds nothing', async (what, script, setup) => {
    const w = world(); setup(w);
    const store = memoryRoundStore();
    await straight(script, w, DEFAULT_LOOP_CONFIG, store);
    const last = (await rounds(store)).at(-1)!;
    const [before, stopper, after] = last.calls;
    expect(before).toMatchObject({ post: 'post-1', claims: { sub: 'austen' }, result: { written: 'b.vue' } });
    expect(after).toEqual({ raw: expect.anything() });
    expect(w.writes).not.toContain('c.vue');
    if (what === 'a post that moved on') {
      expect(stopper).toEqual({ raw: expect.anything(), error: expect.stringContaining('edited or deleted') });
    } else {
      expect(stopper!.result ?? stopper!.error).toBeDefined();
    }
  });
});

describe('an invocation continues the turn the one before it left', () => {
  // MUTATION: write results only as the round ends, and the second invocation writes `a.vue` again.
  it('does not dispatch a call already run, nor call the model for its round', async () => {
    const w = world();
    const inner = memoryRoundStore();
    let updates = 0;
    let evicted = false;
    // The Galaxy goes away after the first call's outcome is stored.
    const store: RoundStore = {
      ...inner,
      update: async (id, round, version) => { updates++; return inner.update(id, round, version); },
      read: async () => {
        if (updates === 1 && !evicted) { evicted = true; throw new Error('evicted'); }
        return inner.read();
      },
    };
    const seen: Seen = [];
    const from = { i: 0 };
    const script = [resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), call('write_file', { path: 'b.vue', content: 'b' }, 'w2'), call('mark_complete', {}, 'c1')])];
    await expect(runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model(script, seen, from)))).rejects.toThrow('evicted');
    expect(w.writes).toEqual(['a.vue']);
    const result = await runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model(script, seen, from)));
    expect(result.stop).toBe('complete');
    expect(w.writes).toEqual(['a.vue', 'b.vue']);
    expect(seen).toHaveLength(1);
  });

  /** A store holding `stored` as the turn's rounds already. */
  async function seeded(stored: StoredRound[], interrupted: number[] = []): Promise<RoundStore> {
    const store = memoryRoundStore(interrupted);
    for (const r of stored) await store.create(r);
    return store;
  }
  const done = (raw: unknown, result: unknown) => ({ raw, post: 'post-1', claims: { sub: 'austen' }, result });

  // MUTATION: look for the first call with no outcome before looking for a recorded stop, and
  // `build` is dispatched.
  it('ends complete from a stored mark_complete, with no model call, and never dispatches the call after it', async () => {
    const w = world();
    const store = await seeded([{ index: 1, text: 'done', calls: [
      done(call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), { written: 'a.vue', oid: 'c1' }),
      { raw: call('mark_complete', { answers: ['post-2'] }, 'c1'), result: { ok: true } },
      { raw: call('build', {}, 'b1') },
    ] }]);
    const seen: Seen = [];
    const result = await runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model([], seen, { i: 0 })));
    expect([result.stop, result.answers, seen.length, w.builds]).toEqual(['complete', ['post-2'], 0, 0]);
  });

  it('ends loop-detected from a stored repeated call, with no model call, and never dispatches the call after it', async () => {
    const w = world();
    const write = (id: string) => call('write_file', { path: 'a.vue', content: 'a' }, id);
    const store = await seeded([
      { index: 1, text: 'one', calls: [done(write('w1'), { written: 'a.vue', oid: 'c1' })] },
      { index: 2, text: 'two', calls: [{ raw: write('w2'), result: { stopped: 'loop-detected', detail: 'repeated tool call write_file' } }, { raw: call('build', {}, 'b1') }] },
    ]);
    const seen: Seen = [];
    const result = await runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model([], seen, { i: 0 })));
    expect([result.stop, seen.length, w.builds]).toEqual(['loop-detected', 0, 0]);
  });

  // MUTATION: answer every call with no outcome as interrupted, and the third is never written.
  it('answers a call found in flight as interrupted, never runs it, and runs the calls after it', async () => {
    const w = world();
    const store = await seeded([{ index: 1, text: 'writing', calls: [
      done(call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), { written: 'a.vue', oid: 'c1' }),
      { raw: call('write_file', { path: 'b.vue', content: 'b' }, 'w2') },
      { raw: call('write_file', { path: 'c.vue', content: 'c' }, 'w3') },
    ] }]);
    const seen: Seen = [];
    const deps = { ...depsOf(w, store, memoryBlobs(), model([resp([call('mark_complete', {}, 'c1')])], seen, { i: 0 })), woken: true };
    const result = await runCodegenLoop(INITIAL, deps);
    expect(result.stop).toBe('complete');
    expect(w.writes).toEqual(['c.vue']);
    const toolMessages = seen[0]![0].filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['w1', 'w2', 'w3']);
    expect(JSON.parse(toolMessages[1]!.content)).toEqual({ error: INTERRUPTED_CALL_ERROR });
  });

  // MUTATION: count an interrupted call in the identical-call detector → the model's retry of the
  // same write ends the turn `loop-detected`, and nothing is written.
  it('lets the model retry a call a wake answered as interrupted', async () => {
    const w = world();
    const write = call('write_file', { path: 'a.vue', content: 'a' }, 'w1');
    const store = await seeded([{ index: 1, text: 'writing', calls: [{ raw: write }] }]);
    const seen: Seen = [];
    const result = await runCodegenLoop(INITIAL, { ...depsOf(w, store, memoryBlobs(), model([
      resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w2')], 'writing it again'),
      resp([call('mark_complete', {}, 'c1')], 'done'),
    ], seen, { i: 0 })), woken: true });
    expect([result.stop, w.writes]).toEqual(['complete', ['a.vue']]);
  });

  // MUTATION: run a woken invocation as an ordinary one → the cut call is made again with no record.
  it('records a model call a wake finds cut off, and makes it again with the note', async () => {
    const w = world();
    const store = await seeded([{ index: 1, text: 'one', calls: [done(call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), { written: 'a.vue', oid: 'c1' })] }]);
    const seen: Seen = [];
    const result = await runCodegenLoop(INITIAL, { ...depsOf(w, store, memoryBlobs(), model([resp([call('mark_complete', {}, 'c2')], 'done')], seen, { i: 0 })), woken: true });
    expect(result.stop).toBe('complete');
    expect(await store.interrupted()).toEqual([2]);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0].at(-1)).toEqual({ role: 'user', content: INTERRUPTED_ROUND_NOTE });
  });

  // MUTATION: record the cut call whatever the row holds → the call is made a third time.
  it('ends interrupted, with no model call, when a wake finds the same model call cut off again', async () => {
    const w = world();
    const store = await seeded([{ index: 1, text: 'one', calls: [done(call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), { written: 'a.vue', oid: 'c1' })] }], [2]);
    const seen: Seen = [];
    const result = await runCodegenLoop(INITIAL, { ...depsOf(w, store, memoryBlobs(), model([], seen, { i: 0 })), woken: true });
    expect([result.stop, result.rounds, result.appliedPaths, seen.length]).toEqual(['interrupted', 1, ['a.vue'], 0]);
  });

  // MUTATION: drop the check before a dispatch → the write runs for a turn that is no longer this one.
  it('dispatches nothing once the turn\'s row names another turn', async () => {
    const w = world();
    const store = await seeded([{ index: 1, text: 'one', calls: [{ raw: call('write_file', { path: 'a.vue', content: 'a' }, 'w1') }] }]);
    const result = await runCodegenLoop(INITIAL, depsOf(w, { ...store, isCurrent: async () => false }, memoryBlobs(), model([], [], { i: 0 })));
    expect([result.stop, w.writes]).toEqual(['not-this-turn', []]);
  });

  // MUTATION: put the note after the interrupted round rather than before it, and the earlier
  // rebuild is no prefix of the later.
  it('puts the note for a cut-off model call after the round before it, before and after that round lands', () => {
    const r1: StoredRound = { index: 1, text: 'one', calls: [done(call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), { written: 'a.vue', oid: 'c1' })] };
    const r2: StoredRound = { index: 2, text: 'two', calls: [done(call('write_file', { path: 'b.vue', content: 'b' }, 'w2'), { written: 'b.vue', oid: 'c2' })] };
    const r3: StoredRound = { index: 3, text: 'three', calls: [done(call('write_file', { path: 'c.vue', content: 'c' }, 'w3'), { written: 'c.vue', oid: 'c3' })] };
    const at = (rs: StoredRound[]) => rebuildTurn({ prompt: PROMPT, rounds: rs, interrupted: [3], blobs: new Map(), config: DEFAULT_LOOP_CONFIG });
    const before = at([r1, r2]);
    const after = at([r1, r2, r3]);
    expect(before.next).toEqual({ kind: 'model', index: 3 });
    expect(before.messages.at(-1)).toEqual({ role: 'user', content: INTERRUPTED_ROUND_NOTE });
    expect(before.messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'w2' });
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages[before.messages.length]).toMatchObject({ role: 'assistant', content: 'three' });
  });

  it('ends as a conflict, with no throw, on rounds that skip or repeat an index', () => {
    const r = (index: number): StoredRound => ({ index, text: `${index}`, calls: [] });
    for (const rs of [[r(1), r(3)], [r(1), r(1)], [r(2)]]) {
      expect(rebuildTurn({ prompt: PROMPT, rounds: rs, interrupted: [], blobs: new Map(), config: DEFAULT_LOOP_CONFIG }).next)
        .toEqual({ kind: 'stop', stop: 'conflict', detail: expect.stringContaining('skip or repeat') });
    }
  });
});

describe('a store that refuses a write stops the invocation', () => {
  // MUTATION: go on to the next step after a refused write, and `b.vue` is written.
  it.each(['conflict', 'not-this-turn'] as const)('%s on a call\'s outcome: no further dispatch and no further model call', async (refusal) => {
    const w = world();
    const inner = memoryRoundStore();
    const store: RoundStore = { ...inner, update: async () => refusal };
    const seen: Seen = [];
    const script = [resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1'), call('write_file', { path: 'b.vue', content: 'b' }, 'w2')]), resp([call('mark_complete', {}, 'c1')])];
    const result = await runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model(script, seen, { i: 0 })));
    expect([result.stop, w.writes, seen.length]).toEqual([refusal, ['a.vue'], 1]);
  });

  it.each(['conflict', 'not-this-turn'] as const)('%s on a new round: no call of it is dispatched', async (refusal) => {
    const w = world();
    const store: RoundStore = { ...memoryRoundStore(), create: async () => refusal };
    const seen: Seen = [];
    const result = await runCodegenLoop(INITIAL, depsOf(w, store, memoryBlobs(), model([resp([call('write_file', { path: 'a.vue', content: 'a' }, 'w1')])], seen, { i: 0 })));
    expect([result.stop, w.writes, seen.length]).toEqual([refusal, [], 1]);
  });
});

describe('a blob is read once per invocation', () => {
  // MUTATION: drop the invocation's cache, and an id is read again before every step.
  it('over five rounds with two read_file calls, run a round per invocation', async () => {
    const w = world({ 'a.md': 'alpha', 'b.md': 'beta' });
    const store = memoryRoundStore();
    const inner = memoryBlobs();
    const counts: Array<Map<string, number>> = [];
    const script = [
      resp([call('read_file', { path: 'a.md' }, 'r1')], 'one'),
      resp([call('write_file', { path: 'x.vue', content: 'x' }, 'w1')], 'two'),
      resp([call('read_file', { path: 'b.md' }, 'r2')], 'three'),
      resp([call('write_file', { path: 'y.vue', content: 'y' }, 'w2')], 'four'),
      resp([call('mark_complete', {}, 'c1')], 'five'),
    ];
    const from = { i: 0 };
    const seen: Seen = [];
    for (let n = 0; n < 10; n++) {
      const reads = new Map<string, number>();
      counts.push(reads);
      const blobs = { write: inner.write, read: async (oid: string) => { reads.set(oid, (reads.get(oid) ?? 0) + 1); return inner.read(oid); } };
      let answered = false;
      const once: CodegenLoopDeps['callModel'] = async (m, p) => { if (answered) throw new Error(PAUSE); answered = true; return model(script, seen, from)(m, p); };
      const result = await runCodegenLoop(INITIAL, depsOf(w, store, blobs, once));
      if (result.stop === 'complete') break;
    }
    const all = counts.flatMap((m) => [...m.values()]);
    expect(all.length).toBeGreaterThan(0);
    expect(Math.max(...all)).toBe(1);
  });
});
