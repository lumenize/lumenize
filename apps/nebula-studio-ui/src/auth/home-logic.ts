/**
 * Every decision the Home screen makes, as pure functions over the summary.
 *
 * ⚠️ **These are functions rather than template branches on purpose.** Which modal a row opens, and
 * whether a row is clickable at all, are decisions — and a decision spelled as the ORDER of a
 * `v-if` / `v-else-if` chain lives where no mutation can flip it and no test can see it
 * (`calibration.md` § *You will put a decision in a framework's syntax*). Home has several such
 * decisions and one of them gates consent, so all of them live here.
 *
 * Nothing in this file reaches the network or reads the DOM, so it can be asserted directly.
 */

/** The wire shapes, mirrored from `@lumenize/nebula-auth`'s `types.ts`. */
export type Tier = 'universe' | 'galaxy' | 'star';

export interface ScopeNode {
  scope: string;
  tier: Tier;
  scopeAdmin?: boolean;
  accepted?: boolean;
  invitedByName?: string;
  invitedByProfileId?: string;
  children?: ScopeNode[];
  childCount?: number;
}

export interface EmailScopes {
  email: string;
  current?: boolean;
  memberships: ScopeNode[];
}

export interface ScopeSummary {
  emails: EmailScopes[];
}

export const PLATFORM_SCOPE = 'nebula-platform';

/**
 * How many children render expanded before a level collapses behind a disclosure.
 *
 * Jennifer has five Galaxies of five to fifty Stars each: the Galaxies all render, and a Galaxy of
 * fifty Stars does not flood the page. The threshold is a rendering preference and lives here rather
 * than on the server, which bounds the READ with its own separate budget.
 */
export const RENDER_ALL_THRESHOLD = 20;

/**
 * Which consent modal a row needs, or `undefined` if it needs none.
 *
 * ⚠️ **Acceptance is the trigger, and the INVITER is the discriminator.** A membership someone was
 * invited into carries an attribution stamp; one they created for themselves does not. The two
 * flavors say materially different things — an invitation names who sent it, a self-signup warns the
 * person that nobody should be here unless they started it — so reading the wrong one is a real
 * failure, not a cosmetic one.
 *
 * A row with no `accepted` field is not a membership at all (it is a descendant reached through
 * one), and descendants are never consented to individually.
 */
export function modalFlavorFor(node: ScopeNode): 'invite' | 'self' | undefined {
  if (node.accepted !== false) return undefined;
  return node.invitedByName || node.invitedByProfileId ? 'invite' : 'self';
}

/**
 * Whether the modal's Accept button may fire.
 *
 * Trivial by design — the point is that the rule has a NAME, so "Accept is disabled until the box is
 * checked" is a property a test can hold the component to rather than a `:disabled` expression
 * nobody reviews.
 */
export function canAccept(consentChecked: boolean): boolean {
  return consentChecked === true;
}

/**
 * Where clicking a row goes, or `undefined` when the row has no surface of its own.
 *
 * ⚠️ **`undefined` is a real answer, not a gap.** A Universe has nowhere to go — there is no universe
 * UI yet, and eventually that is where a person manages their Galaxies. Such a row renders as an
 * unclickable label, and accepting one stays on Home and re-renders it accepted rather than
 * navigating into a page that does not exist.
 *
 * ⚠️ **The reserved platform scope is covered by the universe arm, NOT by a check of its own — and
 * whoever builds universe UI inherits an obligation here.** `nebula-platform` is a single segment,
 * and the server derives tier from segment count, so it always arrives as a universe and falls out
 * unclickable for that reason. An explicit `scope === PLATFORM_SCOPE` guard was written first and
 * deleted: nothing could reach it, so no test could red it, and a guard no test can red is one a
 * later reader trusts for a reason that was never true. The moment a universe gains a surface, that
 * incidental coverage ends and the platform root becomes clickable into a Studio that does not exist
 * — so add the guard back THEN, with a test that can fail.
 */
export function surfaceFor(node: ScopeNode): string | undefined {
  if (node.tier === 'star') return `/app/${node.scope}`;
  if (node.tier === 'galaxy') return `/studio/${node.scope}`;
  return undefined; // universe — no surface yet, and that is what covers the platform root
}

/** Whether a level renders every child, or collapses behind a disclosure. */
export function rendersExpanded(children: readonly unknown[] | undefined): boolean {
  return (children?.length ?? 0) <= RENDER_ALL_THRESHOLD;
}

/**
 * The one destination to skip Home for entirely, if there is one.
 *
 * Someone whose entire account is a single Star they have already accepted came here to use an app,
 * not to choose between one option. Every other shape — more than one membership, anything
 * unaccepted, anything that is not a Star — renders Home.
 *
 * ⚠️ **ACCEPTED is load-bearing.** Fast-forwarding an unaccepted membership would carry the person
 * past the consent modal into a surface whose session is inert, which is both the wrong outcome and
 * a confusing one: they would arrive somewhere that immediately refuses them.
 */
export function fastForwardTarget(summary: ScopeSummary): string | undefined {
  const all = summary.emails.flatMap((e) => e.memberships);
  if (all.length !== 1) return undefined;
  const only = all[0];
  if (only.accepted !== true || only.tier !== 'star') return undefined;
  return surfaceFor(only);
}

/**
 * The hand-off hint Home leaves for Studio: which cookie to spend at a destination.
 *
 * ⚠️ **The KEY is where you are going and the VALUE is where your session lives**, and getting them
 * the wrong way round is silent — it writes a real entry that Studio reads and then refreshes
 * against a path holding no cookie. Studio owns this key (`App.vue`'s `authHint`), which is why the
 * shape is pinned here rather than spelled inline at the call site.
 *
 * Not derivable at the destination: `/studio/acme.crm` cannot know the session was established at
 * `acme`, because a person's cookie sits at whatever scope their link named.
 */
export function authHintFor(destinationScope: string, authScope: string): { key: string; value: string } {
  return { key: `nebula.authScope:${destinationScope}`, value: authScope };
}

/**
 * The banner a non-session email's section carries, or `undefined` for the current one.
 *
 * Every address on the identity is listed, but this browser only holds cookies for the one it signed
 * in as. Clicking into another address's tenancy means a fresh sign-in, and saying so up front beats
 * a login form appearing without explanation.
 */
export function crossEmailNotice(section: EmailScopes): string | undefined {
  return section.current ? undefined : `Signing in here emails ${section.email}`;
}
