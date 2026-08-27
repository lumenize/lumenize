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
import { createResourceOntologyProvider } from '../../../src/devstudio-resource-ontology';

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

  // --- Resource data-plane facet hooks ---
  // These mount + exercise the Session/Message facet the way Galaxy.onStart's composed
  // data-plane does, without needing a Gateway/client. The provider is reconstructed
  // here (same bundleId → same cached facet) since the composed `#dataPlane` is private.

  /** Parse a value through the Session/Message facet, with the tool-args facet ALSO
   *  mounted in THIS DO first — a passing parse therefore proves no Worker-Loader
   *  bundleId cross-wiring (M2) on top of the ADR-006 embed-guard (SC3). */
  @mesh(requireDominionHere)
  async parseSessionTurnForTest(typeName: string, value: unknown): Promise<ParseResult> {
    // If the Session/Message bundleId collided with the tool-args id, the facet
    // below would serve THIS validator and a valid Message would fail to parse.
    getParserValidatorFacet(this.ctx, this.env.LOADER, TOOL_ARGS_BUNDLE_ID, () => generateParseModule(TOOL_ARGS_TYPES));
    const { facet } = createResourceOntologyProvider(this.ctx, this.env.LOADER)();
    return facet.parse(value, typeName);
  }

  /** The fixed Session/Message ontology version (server-sourced) — for the wipe/re-init check. */
  @mesh(requireDominionHere)
  resourceOntologyVersionForTest(): string {
    return createResourceOntologyProvider(this.ctx, this.env.LOADER)().version;
  }

  /** The relationship metadata the `getOntology()` seam carries — exercises the REAL
   *  provider closure (this.ctx/this.env.LOADER), so dropping `relationships` from the
   *  provider returns `undefined` here (red). */
  @mesh(requireDominionHere)
  resourceRelationshipsForTest(): unknown {
    return createResourceOntologyProvider(this.ctx, this.env.LOADER)().relationships;
  }

  /** Re-run onStart to simulate a DO restart / re-init (M3 wipe-recovery). */
  @mesh(requireDominionHere)
  async reInitForTest(): Promise<void> {
    await this.onStart();
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
