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
import { isAtOrAbove } from '@lumenize/nebula/frontend';

/** The wire shapes, mirrored from `@lumenize/mesh/auth`'s `types.ts`. */
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
  memberships: ScopeNode[];
}

export interface ScopeSummary {
  emails: EmailScopes[];
}

/** What `POST /auth/home-summary` answers: one summary per Profile the browser's cookies resolve
 *  to, and the scopes of the cookies whose memberships are still pending. */
export interface HomeSummary {
  groups: { profileId: string; summary: ScopeSummary }[];
  pending: string[];
  /** The accepted cookies the summary read, with their admin bit. */
  held: HeldSession[];
}

/** A cookie Home's summary read: the scope its membership sits at, and whether it is an admin's. */
export interface HeldSession {
  scope: string;
  scopeAdmin: boolean;
}

/**
 * Whether opening a row's host from this browser needs a fresh login.
 *
 * A host's refresh mints from that membership's own cookie, or from an admin cookie at or above it,
 * so a row covered by neither would answer 401 there: an app accepted on another device, say, which
 * this browser holds no cookie for. A plain cookie above the row covers nothing — a plain membership
 * mints on its own host alone.
 */
export function needsFreshLogin(row: ScopeNode, held: readonly HeldSession[]): boolean {
  return !held.some((h) => h.scope === row.scope || (h.scopeAdmin && isAtOrAbove(h.scope, row.scope)));
}

export const PLATFORM_SCOPE = '_platform';

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
 * Trivial by design — the point is that the rule has a NAME, so "Accept needs the box AND a
 * nickname" is a property a test can hold the component to rather than a `:disabled` expression
 * nobody reviews.
 *
 * Two conditions. The checkbox is what makes this a decision rather than a dialog someone dismisses.
 * The nickname is what everyone else in the account sees next to anything this person posts, and
 * collecting it HERE is what lets every app surface drop its own blocking "what should we call you?"
 * modal: a person is asked once, at the moment they agree to be somewhere, and is never interrupted
 * mid-task afterwards.
 */
export function canAccept(consentChecked: boolean, nickname: string): boolean {
  return consentChecked === true && nickname.trim().length > 0;
}

/**
 * Where clicking a row goes, or `undefined` when the row has no surface of its own.
 *
 * Every scope is served from its own host (ADR-021): a Universe's page at `acme.lumenize.dev`, a
 * Galaxy's Studio at `crm.acme.lumenize.dev`, a Star's running app at
 * `tenant1.crm.acme.lumenize.dev`. `urlFor` spells a scope's host, so this stays a pure decision
 * over the row.
 *
 * ⚠️ **The reserved platform scope is the one universe with NO surface, and it needs an explicit
 * guard.** `_platform` is a single segment, so the server always delivers it as a universe;
 * without this line the platform root would be clickable into a host no scope spells. The guard is
 * reachable and `home-logic.test.ts` reds if it is removed.
 */
export function surfaceFor(node: ScopeNode, urlFor: (scope: string) => string): string | undefined {
  if (node.scope === PLATFORM_SCOPE) return undefined; // the platform root has no page of its own
  return urlFor(node.scope);
}

/**
 * Whether an account's row offers adding an app and deleting the account — links to the account's
 * own page, which performs both. Only an accepted admin of the account can do either there, and the
 * reserved platform scope has no page.
 */
export function offersAccountActions(node: ScopeNode): boolean {
  return node.tier === 'universe' && node.scopeAdmin === true && node.accepted === true && node.scope !== PLATFORM_SCOPE;
}

/**
 * Whether an app's row offers its delete — a link to the app's Studio, which performs it. Its
 * accepted admin can delete it there, and so can an accepted admin of the account above it, whose
 * row is `account`. A row of the summary's descent has no `accepted` of its own.
 */
export function offersAppDelete(node: ScopeNode, account?: ScopeNode): boolean {
  if (node.tier !== 'galaxy') return false;
  if (node.accepted !== undefined) return node.scopeAdmin === true && node.accepted === true;
  return account !== undefined && offersAccountActions(account);
}

/** Whether a level renders every child, or collapses behind a disclosure. */
export function rendersExpanded(children: readonly unknown[] | undefined): boolean {
  return (children?.length ?? 0) <= RENDER_ALL_THRESHOLD;
}

/**
 * The one destination to skip Home for entirely, if there is one.
 *
 * Someone whose entire account is a single membership came here to use it, not to choose between one
 * option — so Home fast-forwards them to it: a universe holding one app to that app's Studio, a
 * universe holding none or several to its page, a lone Star to its running app. Every other shape
 * renders Home: more than one membership (a real choice), anything unaccepted (its consent comes
 * first), or a single membership with no surface.
 *
 * ⚠️ **ACCEPTED is load-bearing.** Fast-forwarding an unaccepted membership would carry the person
 * past the consent modal into a surface whose session is inert, which is both the wrong outcome and
 * a confusing one: they would arrive somewhere that immediately refuses them.
 *
 * ⚠️ **A surfaceless single membership stays on Home, and that is what keeps the superuser here.** A
 * lone `_platform` membership has no surface ({@link surfaceFor} returns `undefined`), so a
 * superuser lands on Home with an unclickable platform row rather than being sent to a Studio that
 * does not exist. This is why the fast-forward is expressed as "has a surface" rather than a tier
 * check — the tier that lacks one drops out for the right reason.
 */
export function fastForwardTarget(summary: ScopeSummary, urlFor: (scope: string) => string): string | undefined {
  const all = summary.emails.flatMap((e) => e.memberships);
  if (all.length !== 1) return undefined;
  const only = all[0];
  if (only.accepted !== true) return undefined;
  // An account holding exactly one app: the one place to work is that app. A frontier past the
  // children listed means more apps than the level shows, so the person has a choice to make.
  const apps = only.tier === 'universe' ? only.children ?? [] : [];
  if (apps.length === 1 && only.childCount === undefined) return surfaceFor(apps[0], urlFor);
  return surfaceFor(only, urlFor);
}

/**
 * Where Home sends a browser with no choice to make: its cookies resolve to one Profile, nothing is
 * pending, and that summary fast-forwards ({@link fastForwardTarget}).
 */
export function homeFastForward(home: HomeSummary, urlFor: (scope: string) => string): string | undefined {
  const only = home.groups.length === 1 && home.pending.length === 0 ? home.groups[0].summary : undefined;
  return only ? fastForwardTarget(only, urlFor) : undefined;
}

/**
 * Where Home goes once a membership is accepted, given the summary re-read after it: where a fresh
 * visit would fast-forward, and otherwise the accepted row's own page. A ticket-backed signup is
 * accepted here, so this is what carries it into its first app, as a claim's link page does.
 */
export function afterAcceptTarget(home: HomeSummary, node: ScopeNode, urlFor: (scope: string) => string): string | undefined {
  return homeFastForward(home, urlFor) ?? surfaceFor(node, urlFor);
}

/**
 * The pending membership a login page should offer consent for instead of a login form, if any.
 *
 * A person who signed in through a plain link without accepting an invite holds that membership's
 * cookie, pending. Visiting the invite's host then fails its refresh, which sends them here with
 * `return_to` naming that host — so the membership at the host's scope is the one to consent to. A
 * pending membership anywhere else is not what they came for, and a login form is.
 */
export function pendingFor(pending: readonly string[], returnScope: string | undefined): string | undefined {
  return returnScope !== undefined && pending.includes(returnScope) ? returnScope : undefined;
}

