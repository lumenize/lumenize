/**
 * DevStar — the Studio sandbox Star, addressed by the reserved 3rd-segment
 * slug `dev` (e.g. instanceName = "acme.app.dev").
 *
 * ⚠️ **Being deleted (Decision 2 — the DevStar→Star collapse).** Phase 3.5c moved
 * the `.dev`-guarded `resetDevData` wipe onto base `Star`; Phase 4's in-DO serve
 * teardown deleted `compileSFC` (vite owns compile now). The only thing left on this
 * subclass is `deployToDev` (the Galaxy lazy-pull trigger), which is removed together
 * with this whole class + the `DEV_STAR` binding in the **next** Phase-4 sub-part
 * (DevStar collapse + Galaxy dev-loop pull-path removal). Until then it inherits all
 * Star machinery and exists only so the `DEV_STAR` binding still resolves.
 *
 * @see tasks/nebula-studio.md § Phase 4 (DevStar collapse)
 */

import { mesh } from '@lumenize/mesh';
import { Star } from './star';
import { requireAdmin } from './nebula-do';
import type { Galaxy } from './galaxy';

export class DevStar extends Star {
  /**
   * Eager version application — the dev-cycle analog of a production Star's *lazy*
   * (cache-miss) ontology pickup: fetch the latest `OntologyState` from Galaxy and
   * apply it via the `applyFetchedState` continuation hook.
   *
   * ⚠️ **Superseded — deleted in the next Phase-4 sub-part.** The dev loop now
   * applies the compiled validator directly via `DevStudio.applyOntology` →
   * `Star.setOntology` (Decision 9), so this Galaxy round-trip is dead. It goes with
   * the class + the Galaxy dev-loop pull-path removal.
   *
   * `@mesh(requireAdmin)`: `onBeforeCall` proves only tenant *scope*, never
   * `access.admin`, and this bespoke `@mesh` method does NOT pass through the DAG
   * `requirePermission` checks — so it carries its own admin gate.
   */
  @mesh(requireAdmin)
  deployToDev(): void {
    this.lmz.call(
      'GALAXY', this.galaxyId,
      this.ctn<Galaxy>().getLatestOntologyVersion(),
      this.ctn().applyFetchedState(this.ctn().$result),
    );
  }
}
