/**
 * What the delete confirmation says is about to go, in the words the UI uses for it.
 *
 * Dominion runs downward and nobody beneath a scope can veto its deletion (ADR-015), so this
 * sentence and the warning beside it are the only restraint a delete has. It names the apps and
 * tenants beneath the thing being deleted by kind, because those are what a person would stop for.
 * An app's own workspace, its `.dev` Star, goes with the app and is not counted: nobody made it as
 * a thing of its own.
 */

/** One entry of a deletion plan, as `client.scopes.deletePlan` answers it. */
export interface AffectedScope {
  /** The scope's id, e.g. `acme.crm.tenant1`. */
  instanceName: string;
  /** `'universe'`, `'galaxy'` or `'star'`. */
  tier: string;
  /** An app's own workspace, `{account}.{app}.dev`. */
  isDev: boolean;
}

/** The deletion plan the confirmation reads. */
export interface DeletionPlan {
  /** The target and everything beneath it. */
  affected: AffectedScope[];
  affectedUsers: { total: number; sample: { instanceName: string; email: string }[] };
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The sentence for a delete of `target`, which the page calls `what`: "this account", "this app" or
 * "the tenant acme-corp".
 *
 * @example
 * deletionSentence('this account', 'acme', plan.affected)
 * // "This permanently deletes this account, its 2 apps and their 6 tenants, and everything in them."
 */
export function deletionSentence(what: string, target: string, affected: readonly AffectedScope[]): string {
  const beneath = affected.filter((a) => a.instanceName !== target);
  const apps = beneath.filter((a) => a.tier === 'galaxy').length;
  const tenants = beneath.filter((a) => a.tier === 'star' && !a.isDev).length;
  if (apps === 0 && tenants === 0) return `This permanently deletes ${what} and everything in it.`;
  // Tenants belong to the apps when apps are named, and to the app being deleted otherwise.
  const parts = [
    ...(apps > 0 ? [`its ${counted(apps, 'app')}`] : []),
    ...(tenants > 0 ? [`${apps > 1 ? 'their' : 'its'} ${counted(tenants, 'tenant')}`] : []),
  ];
  const list = parts.length === 1 ? `${what} and ${parts[0]}` : `${what}, ${parts[0]} and ${parts[1]}`;
  return `This permanently deletes ${list}, and everything in them.`;
}
