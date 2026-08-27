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
import { DEFAULT_LOOP_CONFIG, TOOL_ARGS_BUNDLE_ID, TOOL_ARGS_TYPES } from '../../../src/codegen-loop';
import type { ChatMessage, ModelParams, CodegenLoopConfig, LoopResult } from '../../../src/codegen-loop';
import { getParserValidatorFacet, generateParseModule } from '@lumenize/ts-runtime-parser-validator';
import type { ParseResult } from '@lumenize/ts-runtime-parser-validator';

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
    getParserValidatorFacet(this.ctx, this.env.LOADER, TOOL_ARGS_BUNDLE_ID, () => generateParseModule(TOOL_ARGS_TYPES));
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

  /** Pin the verdict: no discriminator model call, straight to the (scripted) codegen path. */
  protected override async discriminate(): Promise<{ respond: true; codegen: boolean }> {
    return { respond: true, codegen: true };
  }

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
