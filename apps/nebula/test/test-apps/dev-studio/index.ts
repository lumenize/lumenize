/**
 * DevStudio test harness (Phase 3.5b). DevStudio `extends NebulaDO` (a constructable
 * SQLite DO), so unlike DevContainer it CAN run under vitest-pool-workers — this
 * project exercises the real node: shell `Workspace` + isomorphic-git (writeSource /
 * commit / readSource / getSourceTree) and the cross-DO compile-and-apply
 * (`compileAndInstallOntology` → `STAR.setOntology`). Driven via `__executeOperation`
 * envelopes (the container-node + interim-dev-loop pattern) — no Gateway/JWT infra.
 *
 * The container-push primitives (`ensureUp`/`syncToDevContainer`) call DEV_CONTAINER
 * (`extends Container`, can't construct here) → deploy-gated `it.skip` in the test.
 *
 * `DevStarOntologyProbe` is the `.dev` data-Star target with a single read hook so a
 * test can confirm `setOntology` installed the compiled version.
 */
import { mesh } from '@lumenize/mesh';
import { DevStudio } from '../../../src/dev-studio';
import { Star } from '../../../src/star';
import { requireAdmin } from '../../../src/nebula-do';
import { DEFAULT_LOOP_CONFIG } from '../../../src/codegen-loop';
import type { ChatMessage, ModelParams, CodegenLoopConfig, LoopResult } from '../../../src/codegen-loop';

// The Galaxy ({u}.{g}) is the turn-recorder store DevStudio writes to.
export { Galaxy } from '../../../src/galaxy';

/**
 * The DEV_STUDIO class under test — a DevStudio whose `callModel` replays a
 * **synthetic script** (no AI binding) so the Phase-2/3 codegen loop is exercised
 * under vitest-pool-workers. The script is one fake `env.AI.run` response per round;
 * `seenMessages` snapshots the transcript handed to the model each round so a test
 * can assert the error-tail round-trips into the next round's user layer.
 *
 * It IS-A DevStudio, so the existing source-of-truth / compile-and-apply tests run
 * against it unchanged (all real methods inherited).
 */
export class DevStudioLoopProbe extends DevStudio {
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

  /** Test-only entry: replay `script` through the real loop driver, return the
   *  LoopResult + the per-round transcripts. Admin-gated like every DevStudio method. */
  @mesh(requireAdmin)
  async runLoopForTest(
    userRequest: string,
    script: unknown[],
    config?: Partial<CodegenLoopConfig>,
  ): Promise<{ result: LoopResult; seenMessages: ChatMessage[][] }> {
    this.#script = script;
    this.#scriptIdx = 0;
    this.#seenMessages = [];
    const cfg: CodegenLoopConfig = { ...DEFAULT_LOOP_CONFIG, ...(config ?? {}) };
    // runCodegenTurn + callModel are protected on DevStudio — reachable here.
    const result = await this.runCodegenTurn(userRequest, cfg);
    return { result, seenMessages: this.#seenMessages };
  }
}

// The `.dev` data-Star target. Post-collapse (Decision 2) the dev Star is a plain
// `Star` at a `{u}.{g}.dev` instance — no DevStar subclass.
export class DevStarOntologyProbe extends Star {
  /** Test-only: the ontology version index (proves `setOntology` installed). */
  @mesh(requireAdmin)
  inspectOntologyIndex(): string[] {
    return this.ctx.storage.kv.get<string[]>('ontology:_index') ?? [];
  }
}

export default {
  fetch(): Response {
    return new Response('dev-studio test harness');
  },
};
