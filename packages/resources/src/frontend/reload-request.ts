/**
 * What a page framed in Studio does with Studio's `lumenize:reload` request (ADR-024's build
 * version). Studio names the build `.dev` now serves; the page compares it with the `buildVersion`
 * the serving layer wrote into its own `nebula-scope` meta. Pure, so a table pins every arm, and
 * the order of the checks lives here rather than in the listener (calibration §12).
 */

/**
 * - `stay` — the page already runs the named build, or this tab already asked the app to refresh
 *   for it; nothing happens.
 * - `refresh` — the page runs another build; the app's `onShouldRefreshUI` gets a `BuildStaleInfo`
 *   and the guard records the build.
 * - `reload` — the request named no build, which is the Reload button: the person asked, so the
 *   page reloads whatever it holds, past the app's hook.
 */
export type ReloadRequestAction = 'stay' | 'refresh' | 'reload';

export interface ReloadRequestInput {
  /** The build the request names, or `undefined` when it names none. */
  requested: string | undefined;
  /** The build this page was served, from its meta; `undefined` when the meta names none. */
  own: string | undefined;
  /** The build the guard last refreshed this tab for, if any. */
  refreshedFor: string | undefined;
}

export function decideReloadRequest(input: ReloadRequestInput): ReloadRequestAction {
  if (input.requested === undefined) return 'reload';
  if (input.requested === input.own) return 'stay';
  return input.refreshedFor === input.requested ? 'stay' : 'refresh';
}
