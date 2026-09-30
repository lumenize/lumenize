/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 *
 * Owns a DAG tree for organizing resources and controlling access, and a
 * temporal resource store — both inside the composed
 * {@link Resources} plane (ADR-007 — composition, not reimplementation), which the
 * Galaxy composes the same way. The plane owns the op, the ontology it validates
 * against and the one version rule; the Star keeps only where its ontology comes from
 * (its parent Galaxy's registry, asked by fire-back), its configuration, and the
 * `.dev` reset that runs the plane's wipe.
 *
 * **One door.** `@mesh() get resources` returns the plane's request surface, whose
 * members derive the caller's own address and check each op; the Star has no per-op
 * entries of its own.
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireDominionHere } from './nebula-do';
import { ROOT_NODE_ID } from './org-ops';
import { Resources } from './resources';
import type { OntologySource, ResourcesHost, ResourcesRequests, ResourcesResults } from './resources';
import type { Galaxy } from './galaxy';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

// Node-invite types re-exported from their home (the composed plane) so
// existing `@lumenize/nebula` import sites are unchanged.
export type { NodeInvitee, NodeInviteAck } from './resources';

export class Star extends NebulaDO implements ResourcesHost {
  #resources!: Resources

  onStart() {
    this.#resources = new Resources(this.ctx, () => this.lmz, this.#ontologySource())
  }

  /**
   * The Star's ontology source: its parent Galaxy's CURRENT row, asked by a call whose answer
   * lands at `resourcesResults.onOntologyPulled`, so `current()` answers `null` and the op is told
   * `installing`. The call rides the asking op's context — an upward call every member has
   * passage for — and asks for CURRENT, never for the version the op pinned: a Star serves its
   * Galaxy's current version, so a tab on an older bundle is told to refresh rather than
   * installed back onto. Sibling Stars share one validator bundle per version, keyed on the
   * Galaxy.
   */
  #ontologySource(): OntologySource {
    return {
      current: () => {
        this.lmz.call('GALAXY', this.galaxyId,
          this.ctn<Galaxy>().getCurrentOntology(),
          this.ctn<Star>().resourcesResults.onOntologyPulled());
        return null
      },
      bundleId: (version) => `${this.galaxyId}/${version}`,
    }
  }

  /**
   * Seed the **initial DataPlane root admin** — a DAG `admin` grant on `ROOT_NODE_ID`, granted to the
   * first **star-scoped admin** to touch this Star.
   *
   * Two distinct things, in two planes, easily conflated: a *star-scoped admin* is a registry
   * `Memberships` row (`scopeAdmin=1` at this 3-segment scope, so the token's `authScope` IS this Star);
   * the *DataPlane root admin* is this DAG grant. This method is the bridge between them, and it runs
   * exactly once — later root admins are added by an ordinary `setPermission`, which is why this one
   * is the **initial** one and not the only possible one.
   *
   * The grant's job is to give the request-access climb a findable terminus *inside the tree*: a
   * scope-admin holding only the `claims.access.scopeAdmin` bypass is **not** in the permissions map, so
   * the climb cannot discover them. `setPermission` satisfies its own `admin` gate via that same
   * bypass (org-tree.ts `requirePermission`), so no un-guarded path is needed.
   *
   * ⚠️ **EXACT-star, not `hasDominionOver`** (2026-08-02). A covering Galaxy/Universe admin passes
   * `hasDominionOver` here, so under the old predicate whichever admin wandered in first took the
   * grant — and because the KV flag is one-shot with no re-seed path, that Star's climb would
   * terminate at the covering admin **forever**, routing its tenants' access requests away from their
   * own Star admin. Requiring `authScope` to EQUAL this Star's id makes the grant follow ownership
   * rather than arrival order. This costs the covering admin nothing: ADR-015 keeps their dominion
   * total via the bypass — only climb *discoverability* is at stake.
   *
   * ⚠️ A Star with no star-scoped admin (`createStar` mints no identity — the `.dev` workspace) simply
   * stays root-adminless until one exists, which is already the behavior for a non-admin first caller.
   * `claim-star` self-signup needs no special machinery: the claimer's `authScope` IS this Star, so it
   * satisfies this gate on their first authenticated touch.
   *
   * ⚠️ Keep this predicate if the seed ever moves onto hosts that are NOT leaves — on a non-leaf
   * host a containment form would let a descendant's admin seed an ancestor.
   */
  onBeforeCall() {
    super.onBeforeCall() // locks the active scope (aud) on first call
    if (this.ctx.storage.kv.get('__nebula_rootAdminSeeded')) return
    const auth = this.lmz.callContext.originAuth
    const claims = auth?.claims as NebulaJwtPayload | undefined
    if (!auth?.sub || !this.lmz.instanceName) return
    // Exact equality, NOT `hasDominionOver` — see the EXACT-star note above. This is the one site
    // where the transient scope-admin bypass becomes a DURABLE DAG grant.
    const access = claims?.access
    if (access?.scopeAdmin !== true || access.authScope !== this.lmz.instanceName) return
    this.#resources.requests.orgTree.setPermission(ROOT_NODE_ID, auth.sub, 'admin')
    this.ctx.storage.kv.put('__nebula_rootAdminSeeded', true)
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Universe-scoped galaxy identifier — the first two dot-segments of Star's
   * instanceName (e.g. `acme.app.tenant-a` → `acme.app`). Both segments
   * together form a globally unique galaxy address: the leading segment is
   * the universe, the second is the galaxy slug, and identical galaxy slugs
   * in different universes produce different identifiers. Used as the
   * Galaxy DO instance name AND as the namespace prefix on the per-Worker
   * Worker Loader cache (`bundleId = "<universe.galaxy>/<version>"`).
   *
   * `protected` (historically so a subclass could reach it; the `DevStar` subclass
   * is gone now, so it's effectively Star-internal). A pure accessor over
   * `instanceName`, not dev logic — leaving it `protected` adds no misusable surface.
   */
  protected get galaxyId(): string {
    const parts = this.lmz.instanceName!.split('.');
    return parts.slice(0, 2).join('.');
  }

  /**
   * The one `@mesh()` door onto the resource plane — its request surface, whose members derive
   * the caller's own address and check each op themselves. A getter, so a chain reads
   * `ctn<Star>().resources.transaction(…)`, the spelling `client.resources.*` already uses.
   */
  @mesh() // any member with passage: each member behind the door checks itself
  get resources(): ResourcesRequests {
    return this.#resources.requests
  }
  /**
   * The plane's response-leg surface — where a failed update's reaper, the node invite's facade
   * answer and this Star's ontology pull land. Deliberately NOT `@mesh()`: those answers arrive
   * locally or at the fire-back door, and neither checks for `@mesh()`. `@mesh()` would let any
   * caller with passage call `onOntologyPulled`, which checks no permission and installs whatever
   * row it is handed — a validator of their own, and on the `.dev` Star, the install's wipe.
   */
  get resourcesResults(): ResourcesResults {
    return this.#resources.results
  }

  /**
   * Reset the dev sandbox to empty — the breaking-edit bargain (a breaking ontology edit
   * invalidates stored snapshots, which we do NOT migrate; the user-developer rebuilds test
   * data). Runs the plane's wipe, which refuses anything but the `.dev` Star, erases only what the
   * plane owns — every Resource, grant and subscription, and the installed ontology — and tells
   * every subscriber. The source of truth is the Galaxy's git `Workspace`, never this Star, so a
   * wipe destroys throwaway test data, never the user's code. The Star's `config` and mesh's
   * identity survive, and the next op installs the Galaxy's current ontology as a first install.
   */
  @mesh(requireDominionHere) // dominion over this Star, and the plane's wipe refuses off `.dev`
  resetDevData(): void {
    this.#resources.wipe()
  }

  // ─── Config ────────────────────────────────────────────────────────

  @mesh(requireDominionHere) // dominion over this Star
  setStarConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh() // any member with passage: the Star's config is shared with its members
  getStarConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }
}
