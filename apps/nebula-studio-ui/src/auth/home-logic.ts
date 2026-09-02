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
  /** True iff the membership was INVITE-minted — the flavour discriminator. See `modalFlavorFor`. */
  invited?: boolean;
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
 * ⚠️ **Acceptance is the trigger, and `invited` is the discriminator.** The two flavours say
 * materially different things — an invitation names who sent it, a self-signup warns the person that
 * nobody should be here unless they started it — so reading the wrong one is a real failure, not a
 * cosmetic one.
 *
 * ⚠️ **It keys on `invited`, NOT on the attribution fields, and that is a correction.** It used to
 * read `invitedByName || invitedByProfileId`; both are optional, so an inviter who supplied no
 * display name on a token carrying no `profileId` produced a stamped row with every stamp field
 * null — and since `JSON.stringify` drops undefined keys, the wire shape was byte-identical to a
 * self-claim. The invitee then met "Only accept if you initiated this signup" for something a third
 * party initiated. `invited` is a boolean derived server-side from `invitedBySub`, which an invite
 * always has.
 *
 * A row with no `accepted` field is not a membership at all (it is a descendant reached through
 * one), and descendants are never consented to individually.
 */
export function modalFlavorFor(node: ScopeNode): 'invite' | 'self' | undefined {
  if (node.accepted !== false) return undefined;
  return node.invited === true ? 'invite' : 'self';
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
 * Scope-first URLs: the scope IS the path. A Universe goes to `/{u}` (its manage-apps page), a
 * Galaxy to `/{u}.{g}` (its Studio), a Star to `/app/{u}.{g}.{s}` (the running app). The Studio
 * shell reads the scope from the first path segment, so its segment count picks the view — one
 * segment is universe (manage-apps) mode, two is workspace (author) mode. Only the Star keeps a
 * prefix, because it is served by the Worker (the built app), not the Studio SPA — and it is the
 * route the `lumenize.dev` data-plane split will lift off this domain entirely.
 *
 * ⚠️ **The reserved platform scope is the one universe with NO surface, and it needs an explicit
 * guard.** `nebula-platform` is a single segment, so the server always delivers it as a universe;
 * without this line the platform root would be clickable into `/nebula-platform`, a Studio page that
 * does not exist. The guard is reachable and `home-logic.test.ts` reds if it is removed.
 */
export function surfaceFor(node: ScopeNode): string | undefined {
  if (node.tier === 'star') return `/app/${node.scope}`;
  if (node.tier === 'galaxy') return `/${node.scope}`;
  if (node.scope === PLATFORM_SCOPE) return undefined; // the platform root has no page of its own
  return `/${node.scope}`; // universe — its manage-apps page
}

/** Whether a level renders every child, or collapses behind a disclosure. */
export function rendersExpanded(children: readonly unknown[] | undefined): boolean {
  return (children?.length ?? 0) <= RENDER_ALL_THRESHOLD;
}

/**
 * The one destination to skip Home for entirely, if there is one.
 *
 * Someone whose entire account is a single membership came here to use it, not to choose between one
 * option — so Home fast-forwards them to it: a self-signup universe to its manage-apps page, a lone
 * Star to its running app. Every other shape renders Home: more than one membership (a real choice),
 * anything unaccepted (its consent comes first), or a single membership with no surface.
 *
 * ⚠️ **ACCEPTED is load-bearing.** Fast-forwarding an unaccepted membership would carry the person
 * past the consent modal into a surface whose session is inert, which is both the wrong outcome and
 * a confusing one: they would arrive somewhere that immediately refuses them.
 *
 * ⚠️ **A surfaceless single membership stays on Home, and that is what keeps the superuser here.** A
 * lone `nebula-platform` membership has no surface ({@link surfaceFor} returns `undefined`), so a
 * superuser lands on Home with an unclickable platform row rather than being sent to a Studio that
 * does not exist. This is why the fast-forward is expressed as "has a surface" rather than a tier
 * check — the tier that lacks one drops out for the right reason.
 */
export function fastForwardTarget(summary: ScopeSummary): string | undefined {
  const all = summary.emails.flatMap((e) => e.memberships);
  if (all.length !== 1) return undefined;
  const only = all[0];
  if (only.accepted !== true) return undefined;
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
 * Not derivable at the destination: `/acme.crm` cannot know the session was established at
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
