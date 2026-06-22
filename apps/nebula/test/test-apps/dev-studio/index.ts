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

export { DevStudio };

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
