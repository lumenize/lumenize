/**
 * DevStar — the Studio sandbox Star, addressed by the reserved 3rd-segment
 * slug `dev` (e.g. instanceName = "acme.app.dev").
 *
 * It **inherits everything a Star has** — its own SQLite, DAG tree,
 * subscriptions, per-Star permissions, the Fix-1 structural scope-isolation
 * `onBeforeCall`, and the Galaxy-admin access bypass — and adds a contained
 * layer of **dev-only** behavior (eager version application + breaking-edit
 * data reset). That behavior lives here, on the subclass, NOT behind a runtime
 * flag on `Star`: a tenant Star must not be able to carry a data-wiping reset,
 * so it must not exist there at all.
 *
 * Addressing is slug-derived (§ Naming & binding selection in
 * tasks/dev-star.md): a caller at `{u}.{g}.dev` targets the `DEV_STAR` binding;
 * any other star slug targets `STAR`. The bare 3-tuple name flows through
 * Fix-1's `buildAuthScopePattern → matchAccess` exactly like any Star, so no
 * scope-isolation-side wiring is needed.
 *
 * @see tasks/dev-star.md
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { Star } from './star';
import { requireAdmin } from './nebula-do';
import { compileSFCToModule } from './compile-module';
import { rewriteServedSpecifiers } from './specifier-rewrite';
import { putAsset, stageScaffold } from './app-bundle';
import type { Galaxy } from './galaxy';

/** Result of {@link DevStar.compileSFC}. On failure `errors` is non-empty and
 *  nothing was persisted; on success `errors` is `[]` and `path` is the served
 *  asset path (`.vue` → `.js`) now resident in Star storage. */
export interface CompileSFCResult {
  path: string;
  errors: string[];
}

export class DevStar extends Star {
  /**
   * Eager version application — the dev-cycle analog of a production Star's
   * *lazy* (cache-miss) ontology pickup. Studio fires this on `deploy_to_dev`
   * (a test initiator stands in until the Studio pipeline is built) so the new
   * ontology / app-bundle version is live in the dev Star *immediately*, not on
   * the next read cache-miss.
   *
   * It runs the **same** path as the lazy Handler-1, just eagerly: fetch the
   * latest `OntologyState` from Galaxy, then apply it via the `protected`
   * `applyFetchedState` hook (which wraps `Star.#installState`). No new "apply
   * module", no dev-only branch in base `Star`. The apply is a cross-DO mesh
   * round-trip (`getLatestOntologyVersion` is `@mesh()` on Galaxy, unreachable
   * synchronously), so success is the **continuation landing**, not a return.
   *
   * `@mesh(requireAdmin)`: `onBeforeCall` proves only tenant *scope*, never
   * `access.admin`, and this is a bespoke `@mesh` method that does NOT pass
   * through the DAG `requirePermission` checks resource ops use — so it carries
   * its own admin gate directly. Without it, anyone able to mint a valid
   * `{u}.{g}.dev` aud could force a re-apply.
   *
   * Null-state is a deliberate no-op (handled in `applyFetchedState`): an
   * un-published Galaxy returns `null`, which means "nothing to apply".
   */
  @mesh(requireAdmin)
  deployToDev(): void {
    // `applyFetchedState` is a public (non-`@mesh`) continuation handler on Star
    // — the same shape as the lazy `doTransaction`/`doRead`/`doSubscribe`
    // handlers — so the typed `this.ctn()` proxy surfaces it directly (no cast).
    this.lmz.call(
      'GALAXY', this.galaxyId,
      this.ctn<Galaxy>().getLatestOntologyVersion(),
      this.ctn().applyFetchedState(this.ctn().$result),
    );
  }

  // `resetDevData` (the `.dev`-guarded data wipe) was MOVED to base `Star` in
  // Phase 3.5c (Decision 2 — the wipe now ships on every `Star`, hard-guarded to the
  // `.dev` instance at runtime; `DevStar` inherits it). The structural containment it
  // used to provide is replaced by Star's runtime `.dev` guard + the `Star.prototype`
  // `@mesh`-surface-freeze test. `DevStar` itself (and `deployToDev`/`compileSFC`
  // below) is deleted in Phase 4. See tasks/nebula-studio.md § Dev-data reset.

  /**
   * Compile a `.vue` SFC **inside the dev Star DO** and persist the runnable ESM
   * into the resident app bundle (the `app-bundle.ts` contract `Star.onRequest`
   * reads). Studio's admin client calls this on each save via `lmz.call`.
   *
   * `@mesh(requireAdmin)`: like the other dev-only mutators it does NOT pass
   * through the DAG `requirePermission` checks resource ops use, and
   * `onBeforeCall` proves only tenant *scope* — so it carries its own admin gate
   * (which also satisfies DevStar's `@mesh`-admin surface freeze, dev-star.md
   * P3). Synchronous: `@vue/compiler-sfc` + `transpileModule` are CPU-only and
   * sync storage needs no `await`.
   *
   * On compile failure returns `{ errors }` (non-empty) and persists nothing —
   * Studio's iterate-on-errors loop reads `errors` to self-correct. On success
   * stages the fixed scaffold (idempotent) and writes the component's ESM at
   * `<name>.js`, returning that served path.
   *
   * Post-compile, the module's bare specifiers are rewritten to the same-origin
   * platform paths the served app resolves under `script-src 'self'`
   * (`vue`→`./vue.js`, `lucide-vue-next/icons/*`→`./vendor/lucide/*.js`). A
   * non-allowlisted bare import is a compile error here — same `errors` channel
   * as a parse failure — so it never reaches the browser as a silent 404. The
   * rewrite lives at this write boundary, NOT in `compile-module.ts`, which keeps
   * emitting canonical bare specifiers (tasks/nebula-self-hosted-assets.md).
   */
  @mesh(requireAdmin)
  compileSFC(path: string, source: string): CompileSFCResult {
    const id = path.replace(/\.vue$/, '');
    const result = compileSFCToModule(source, id);
    if (result.errors.length > 0) {
      debug('nebula.DevStar.compileSFC').debug('compile errors', {
        instanceName: this.lmz.instanceName,
        path,
        errorCount: result.errors.length,
      });
      return { path, errors: result.errors };
    }
    const rewrite = rewriteServedSpecifiers(result.module);
    if (rewrite.errors.length > 0) {
      debug('nebula.DevStar.compileSFC').debug('specifier errors', {
        instanceName: this.lmz.instanceName,
        path,
        errorCount: rewrite.errors.length,
      });
      return { path, errors: rewrite.errors };
    }
    stageScaffold(this.ctx);
    const jsPath = `${id}.js`;
    putAsset(this.ctx, jsPath, rewrite.code, 'text/javascript; charset=utf-8');
    debug('nebula.DevStar.compileSFC').debug('compiled', {
      instanceName: this.lmz.instanceName,
      path: jsPath,
    });
    // Signal subscribed preview clients to re-fetch the freshly-compiled bundle.
    // `broadcastReload` is the base-`Star` serving hook (no-op when no preview is
    // subscribed); calling it here is what makes the dev loop "save → reload".
    this.broadcastReload();
    return { path: jsPath, errors: [] };
  }
}
