/**
 * Galaxy codegen test harness (the `dev-studio` vitest project — its name predates the
 * collapse of DevStudio into Galaxy). Galaxy `extends NebulaDO` (a constructable SQLite
 * DO), so it runs under vitest-pool-workers — this project exercises the real node: the
 * `@cloudflare/computer` Workspace + host-side git (writeSource / commit / readSource)
 * and the cross-DO compile-and-apply (`compileAndInstallOntology` → `STAR.setOntology`
 * on the derived `{u}.{g}.dev` star). Driven via `__executeOperation` envelopes (the
 * interim-dev-loop pattern) — no Gateway/JWT infra.
 *
 * `DevStarOntologyProbe` is the `.dev` data-Star target with a single read hook so a
 * test can confirm `setOntology` installed the compiled version.
 */
import { mesh } from '@lumenize/mesh';
import { Galaxy } from '../../../src/galaxy';
import { Star } from '../../../src/star';
import { requireDominionHere } from '../../../src/nebula-do';
import { DEFAULT_LOOP_CONFIG } from '../../../src/codegen-loop';
import { TOOL_ARGS_BUNDLE_ID } from '../../../src/tool-args-constants';
import { TOOL_ARGS_VALIDATOR_MODULE } from '../../../src/validator-seeds';
import { ROW_PATH, wsPath } from '../../../src/build-report';
import type { BuildReport } from '../../../src/build-report';
// A test Worker never deploys, so compiling here is licensed — the probe's faked
// build seam compiles in place of the container.
import { compileOntologyVersion } from '../../../src/ontology-compile';
import type { ChatMessage, ModelParams, CodegenLoopConfig, LoopResult } from '../../../src/codegen-loop';
import { getParserValidatorFacet } from '@lumenize/ts-runtime-parser-validator/runtime';
import type { ParseResult } from '@lumenize/ts-runtime-parser-validator/runtime';

/**
 * The GALAXY class under test — a Galaxy whose `callModel` replays a **synthetic
 * script** (no AI binding) so the codegen loop is exercised under vitest-pool-workers.
 * The script is one fake `env.AI.run` response per round; `seenMessages` snapshots the
 * transcript handed to the model each round so a test can assert the error-tail
 * round-trips into the next round's user layer.
 *
 * It IS-A Galaxy, so the source-of-truth / compile-and-apply tests run against it
 * unchanged (all real methods inherited).
 */
export class GalaxyLoopProbe extends Galaxy {
  // Ephemeral — set + consumed synchronously within one runLoopForTest call (the
  // whole loop is awaited inside it; nothing persists across invocations).
  #script: unknown[] = [];
  #scriptIdx = 0;
  #seenMessages: ChatMessage[][] = [];

  protected override async callModel(messages: ChatMessage[], _params: ModelParams): Promise<unknown> {
    this.#seenMessages.push(messages.map((m) => ({ ...m })));
    const next = this.#script[this.#scriptIdx++];
    if (next === undefined) throw new Error('fake model script exhausted');
    return next;
  }

  /**
   * The BUILD SEAM, faked faithfully: no container exists under pool-workers, so the
   * probe compiles IN PLACE (a test Worker may carry the compiler) and writes the row
   * exactly where the real job does — an fs write at ROW_PATH via `workspaceFs()`,
   * never `writeSource` (the mount does not git-commit). `appendWorkspaceOntology`'s
   * host-side read-back, version check and append-only transaction then run
   * UNCHANGED, which is what the registry + lazy-pull suite exercises.
   */
  protected override async build(
    opts: { ontology?: { version: string; wipe: boolean } } = {},
  ): Promise<BuildReport> {
    let ontology: BuildReport['ontology'];
    if (!opts.ontology) {
      ontology = { ran: false, why: 'no ontology change (host passed no version)' };
    } else {
      try {
        const types = await this.workspaceFs().readFile(wsPath('src/ontology.d.ts'), 'utf8');
        const row = compileOntologyVersion({
          version: opts.ontology.version,
          types,
          ...(opts.ontology.wipe ? { wipeOnInstall: true } : {}),
        });
        await this.workspaceFs().mkdir(wsPath('.nebula'), { recursive: true });
        await this.workspaceFs().writeFile(wsPath(ROW_PATH), JSON.stringify(row));
        ontology = { ran: true, ok: true, rowPath: ROW_PATH };
      } catch (e) {
        ontology = { ran: true, ok: false, tail: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      container: { ran: true, ok: true },
      ontology,
      typeCheck: { ran: true, checked: [], findings: [] },
      bundle: { ran: true, ok: true },
      preview: { refreshed: false, why: 'not decided at the build layer' },
    };
  }

  /** Seed the fake-model script (subclass-reachable — the `#` fields are class-private). */
  protected setScriptForTest(script: unknown[]): void {
    this.#script = script;
    this.#scriptIdx = 0;
    this.#seenMessages = [];
  }

  /** Test-only entry: replay `script` through the real loop driver, return the
   *  LoopResult + the per-round transcripts. Admin-gated like every codegen method. */
  @mesh(requireDominionHere)
  async runLoopForTest(
    userRequest: string,
    script: unknown[],
    config?: Partial<CodegenLoopConfig>,
  ): Promise<{ result: LoopResult; seenMessages: ChatMessage[][] }> {
    this.#script = script;
    this.#scriptIdx = 0;
    this.#seenMessages = [];
    const cfg: CodegenLoopConfig = { ...DEFAULT_LOOP_CONFIG, ...(config ?? {}) };
    // runCodegenTurn + callModel are protected on Galaxy — reachable here.
    const result = await this.runCodegenTurn(userRequest, cfg);
    return { result, seenMessages: this.#seenMessages };
  }

  // --- Chat-ontology facet hooks ---
  // These exercise the INSTALLED chat ontology exactly the way the composed data-plane's
  // provider does — through the protected `chatOntology()` accessor (the same
  // self-seeding install + loader mount), without needing a Gateway/client.

  /** Parse a value through the INSTALLED Chat/Message facet, with the tool-args facet
   *  ALSO mounted in THIS DO first — a passing parse therefore proves no Worker-Loader
   *  bundleId cross-wiring (M2) on top of the ADR-006 embed-guard (SC3). */
  @mesh(requireDominionHere)
  async parseChatMessageForTest(typeName: string, value: unknown): Promise<ParseResult> {
    // If the chat bundleId collided with the tool-args id, the facet below would serve
    // THIS validator and a valid Message would fail to parse.
    getParserValidatorFacet(this.ctx, this.env.LOADER, TOOL_ARGS_BUNDLE_ID, () => TOOL_ARGS_VALIDATOR_MODULE);
    return this.chatOntology().facet.parse(value, typeName);
  }

  /** The INSTALLED chat-ontology version (server-sourced) — for the wipe/re-init check. */
  @mesh(requireDominionHere)
  resourceOntologyVersionForTest(): string {
    return this.chatOntology().version;
  }

  /** The relationship metadata the `getOntology()` seam carries — exercises the REAL
   *  installed row, so dropping `relationships` from the accessor returns `undefined`
   *  here (red). */
  @mesh(requireDominionHere)
  resourceRelationshipsForTest(): unknown {
    return this.chatOntology().relationships;
  }

  /** Re-run onStart to simulate a DO restart / re-init (M3 wipe-recovery). */
  @mesh(requireDominionHere)
  async reInitForTest(): Promise<void> {
    await this.onStart();
  }

  /** The keys of the entry-reaching deps `runCodegenTurn` builds — the resource-surface
   *  test asserts they are exactly `LOOP_TOOL_ENTRIES`'s. */
  loopToolDepKeysForTest(): string[] {
    return Object.keys(this.loopToolDeps()).sort();
  }

  /** Remove a Workspace file — e.g. `AGENTS.md`, so a turn runs on a Workspace without
   *  the Galaxy layer (the shape of a Galaxy seeded before the layer existed). */
  async removeFileForTest(path: string): Promise<void> {
    await this.workspaceFs().rm(wsPath(path));
  }

  // --- The model lanes: capture what each sends without an inference ---
  #lane?: 'rest' | 'binding';
  #capturedRun?: { model: string; body: unknown; options: unknown };
  protected override modelLane(): 'rest' | 'binding' {
    return this.#lane ?? super.modelLane();
  }
  protected override aiBinding() {
    return {
      run: async (model: string, body: unknown, options?: unknown) => {
        this.#capturedRun = { model, body, options };
        return { response: 'stub' };
      },
    };
  }
  #capturedRestHeaders?: Record<string, string>;
  /** Statuses the fake transport answers with, in order (200 after the queue empties);
   *  a 429 carries `retry-after: 0` so the lane's backoff costs the test nothing. */
  #restStatuses: number[] = [];
  #restCalls = 0;
  protected override restFetch(_url: string, init: RequestInit): Promise<Response> {
    this.#capturedRestHeaders = { ...(init.headers as Record<string, string>) };
    this.#restCalls++;
    const status = this.#restStatuses.shift() ?? 200;
    if (status !== 200) return Promise.resolve(new Response('refused', { status, headers: { 'retry-after': '0' } }));
    return Promise.resolve(new Response(JSON.stringify({ success: true, result: { response: 'stub' } }),
      { headers: { 'content-type': 'application/json' } }));
  }
  /** Drive the REST lane through a status sequence; returns how many calls the lane made
   *  and whether it threw — the retry-on-429 contract. */
  async runRestStatusesForTest(statuses: number[]): Promise<{ calls: number; error?: string }> {
    this.#lane = 'rest';
    const env = this.env as { CLOUDFLARE_ACCOUNT_ID?: string };
    const had = env.CLOUDFLARE_ACCOUNT_ID;
    env.CLOUDFLARE_ACCOUNT_ID ??= 'account-for-test';
    this.#restStatuses = [...statuses];
    this.#restCalls = 0;
    try {
      await this.runModel('@cf/test/model', { messages: [] });
      return { calls: this.#restCalls };
    } catch (e) {
      return { calls: this.#restCalls, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.#lane = undefined;
      if (had === undefined) delete env.CLOUDFLARE_ACCOUNT_ID;
    }
  }
  /** Run `runModel` on the REST lane against the capturing transport and return the headers
   *  `#callModelRest` put on the wire — the affinity header at its CALL SITE. */
  async runModelViaRestForTest(): Promise<Record<string, string>> {
    this.#lane = 'rest';
    const env = this.env as { CLOUDFLARE_ACCOUNT_ID?: string };
    const had = env.CLOUDFLARE_ACCOUNT_ID;
    env.CLOUDFLARE_ACCOUNT_ID ??= 'account-for-test'; // the lane refuses to build a URL without one
    try {
      this.#capturedRestHeaders = undefined;
      await this.runModel('@cf/test/model', { messages: [] });
      return this.#capturedRestHeaders ?? {};
    } finally {
      this.#lane = undefined;
      if (had === undefined) delete env.CLOUDFLARE_ACCOUNT_ID;
    }
  }
  /** Run `runModel` on the BINDING lane against the capturing stub and return the options
   *  it passed — the affinity header's presence on that lane. */
  async runModelViaBindingForTest(): Promise<{ options: unknown; headers: Record<string, string> }> {
    this.#lane = 'binding';
    try {
      this.#capturedRun = undefined;
      await this.runModel('@cf/test/model', { messages: [] });
      // Read through a local: TS narrows the field to `undefined` after the assignment
      // above and cannot see the stub's write inside `aiBinding().run`.
      const captured = this.#capturedRun as { options: unknown } | undefined;
      return { options: captured?.options, headers: this.modelCallHeaders() };
    } finally {
      this.#lane = undefined;
    }
  }
}

/**
 * The residency-hold probe — a Galaxy whose model HANGS on demand and whose turn-result
 * delivery is captured in storage, so the single-flight latch + generation deadline are
 * drivable in-lane (the criterion: a never-resolving model call must NOT wedge the loop —
 * a post-deadline fresh message triggers a NEW generation).
 */
export class GalaxyDeadlineProbe extends GalaxyLoopProbe {
  protected override generationDeadlineMs = 800;
  #hangNext = false;

  protected override async callModel(messages: ChatMessage[], params: ModelParams): Promise<unknown> {
    if (this.#hangNext) {
      this.#hangNext = false;
      return new Promise(() => { /* a genuinely never-resolving env.AI await */ });
    }
    return super.callModel(messages, params);
  }

  /** Capture the durable commits in kv instead of the real data plane (no chat host
   *  claims machinery in this lane's direct-probe drive; the REAL commit path is the
   *  baseline reload-contract's scripted trigger). */
  protected override async commitAgentMessage(
    _chatId: string, messageId: string, content: string, _nodeId: string, replyTo: string,
  ): Promise<void> {
    const seen = this.ctx.storage.kv.get<{ messageId: string; content: string; replyTo: string }[]>('probe:committed') ?? [];
    seen.push({ messageId, content, replyTo });
    this.ctx.storage.kv.put('probe:committed', seen);
  }

  /**
   * The whole scenario in one entry (the concurrency is the subject, so it must run
   * inside one DO invocation): (1) a HUNG generation starts (detached, like the commit
   * trigger fires it); (2) a second trigger while it hangs is REFUSED by the
   * single-flight latch (returns at once, generates nothing); (3) the hung turn hits
   * the deadline and releases the latch; (4) a FRESH trigger then runs a NEW
   * generation to a durable commit. Outcomes persisted for the test's poll.
   */
  @mesh(requireDominionHere)
  async chatDeadlineScenario(): Promise<void> {
    // One text-only model round (OpenAI shape, zero tool_calls) → the loop's safe
    // no-tool-calls stop; its content becomes the fresh turn's reply.
    this.setScriptForTest([
      { choices: [{ message: { content: 'fresh turn ran', reasoning_content: '', tool_calls: [] } }] },
    ]);
    // (1) The hung generation (fired, not awaited — the hang is the point).
    this.#hangNext = true;
    const t0 = Date.now();
    const hung = this.runTriggeredTurn('m-hung', 'hang please');
    // Yield one microtask so the hung turn takes the latch before (2) probes it.
    await Promise.resolve();
    // (2) Single-flight: refused at once — no model round, no commit.
    const busyStart = Date.now();
    await this.runTriggeredTurn('m-busy', 'me too');
    const busyMs = Date.now() - busyStart;
    // (3) The deadline releases the latch (the hung model call never resolves).
    await hung;
    const hungMs = Date.now() - t0;
    // (4) THE CRITERION: a fresh trigger now runs a NEW generation to completion.
    await this.runTriggeredTurn('m-fresh', 'try again');
    this.ctx.storage.kv.put('probe:scenario', {
      busyMs,
      hungMs,
      committed: this.ctx.storage.kv.get('probe:committed') ?? [],
    });
  }
}

// The `.dev` data-Star target — a plain `Star` at a `{u}.{g}.dev` instance.
export class DevStarOntologyProbe extends Star {
  /** Test-only: the ontology version index (proves `setOntology` installed). */
  @mesh(requireDominionHere)
  inspectOntologyIndex(): string[] {
    return this.ctx.storage.kv.get<string[]>('ontology:_index') ?? [];
  }
}

export default {
  fetch(): Response {
    return new Response('galaxy codegen test harness');
  },
};
