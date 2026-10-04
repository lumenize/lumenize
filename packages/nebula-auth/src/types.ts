/**
 * Nebula Auth types
 *
 * @see tasks/archive/nebula-auth.md — original auth architecture (archived design record;
 *   the current identity model is per the inline citations below + ADR-013).
 */

// ⚠️ `ResolvedEmail` is imported from `@lumenize/email`, NEVER copied. That package declares it
// (`@lumenize/auth` merely re-exported it), and `NebulaEmailSender` feeds it straight to
// `EmailTransport.sendEmail` — so it is the one member of the 2026-07-31 copy set that must stay in
// lockstep with its owner, and therefore carries no free-to-diverge licence.
import type { ResolvedEmail } from '@lumenize/email';
// ⚠️ The Node/browser-safe `/client` subpath, deliberately — this module is re-exported from
// `@lumenize/nebula-auth/testing`, which must load outside Workers. The main `@lumenize/mesh`
// barrel would drag `cloudflare:workers` in.
import { TOKEN_REFRESH_AHEAD_SECONDS } from '@lumenize/mesh/client';
export type { ResolvedEmail };

/** Fields every `EmailMessage` variant carries. Internal — the union below is the public shape. */
type EmailMessageBase = {
  to: string;
  /** The `universeGalaxyStarId` this mail is about — stamped as the routing header, never derived. */
  instanceName: string;
};

/**
 * Discriminated union for email messages sent by Nebula auth.
 *
 * ⚠️ **COPIED from `packages/auth/src/types.ts` on 2026-07-31 — a DELIBERATE DIVERGENCE, not to be
 * re-synced** (`tasks/archive/nebula-auth-decouple-from-auth.md`). Nebula-specific templates are wanted
 * soon, and each would otherwise be an override fighting a shared default, or Nebula vocabulary
 * pushed into the MIT package.
 *
 * All five variants were copied **verbatim**; Nebula emits `magic-link`, `invite-new`, and
 * `invite-existing` today (the invite entry picks between the last two by acceptance —
 * `invite-entry.ts`), so pruning the remaining two is not a YAGNI question either.
 *
 * Subject lines are controlled by `NebulaEmailSender` via overridable methods — not part of this type.
 *
 * ⚠️ **`instanceName` is REQUIRED on every variant, and that is the point.** The sender stamps its
 * routing header straight from this field. It used to re-parse the instance back out of whichever
 * URL the message carried, which could only ever tag mail whose URL had an instance segment — so a
 * message that IS about an instance but links to `/app` shipped untagged even though its instance
 * was known. Making the field required means the compiler, not a per-type table, guarantees every
 * send site supplies it: a new variant cannot be added without one, and a send site that forgets is
 * a type error rather than a silent mis-route. (An untagged mail lands in the email-test catch-all
 * bucket, so `waitForEmail({ instance })` never matches and the caller dies on a timeout with
 * nothing pointing at the sender.)
 */
export type EmailMessage =
  | (EmailMessageBase & { type: 'magic-link'; magicLinkUrl: string })
  | (EmailMessageBase & { type: 'admin-notification'; subjectEmail: string; approveUrl: string })
  | (EmailMessageBase & { type: 'approval-confirmation'; redirectUrl: string })
  | (EmailMessageBase & { type: 'invite-existing'; redirectUrl: string })
  | (EmailMessageBase & { type: 'invite-new'; inviteUrl: string });

/**
 * RFC 8693 §4.1 delegation actor — a LOCAL widening of `@lumenize/crypto`'s `ActClaim` that adds the
 * actor's `profileId`, because the claims of a narrower token must describe **two people**: top-level
 * claims pertain to the subject, `act` to the actor who is driving.
 *
 * `profileId` is **required**, like the top-level claim: every mint takes one, so every actor's own token
 * carries it. ADR-013 makes it display-only.
 *
 * ⚠️ **Local, deliberately.** `@lumenize/crypto` is a shared primitive package with its own consumers; widening
 * its type is out of scope. ⚠️ **Not a pending reconciliation** — `tasks/archive/nebula-auth-decouple-from-auth.md`
 * considered folding this widening into the shared package and REJECTED it. This widened chain is also
 * exactly what persists: `apps/nebula`'s `Snapshots.actingToken` column stores the full
 * `ActingTokenRecord` (ADR-016), whose `act` is this type — the old narrow-`changedBy` interim and its
 * `projectActClaim` projection were deleted when `nebula-pre-alpha.md`'s schema-surgery item 6 landed
 * (2026-08-20).
 *
 * Recursive per RFC 8693, outermost = current. This endpoint's mint never nests (the root-identity gate
 * refuses an act-bearing caller and the builder writes a flat actor), but depth ≤ 1 is a property of
 * THAT mint, not of the system — a platform prepending itself as an additional actor does nest.
 */
export interface ActClaim {
  sub: string;
  /** The actor's PUBLIC profile address — display-only (ADR-013). */
  profileId: string;
  act?: ActClaim;
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** The three tiers of the Nebula hierarchy */
export type Tier = 'universe' | 'galaxy' | 'star';

// ---------------------------------------------------------------------------
// Parsed universeGalaxyStarId
// ---------------------------------------------------------------------------

/** Result of parsing a `universeGalaxyStarId` string */
export interface ParsedId {
  /** Original input string */
  raw: string;
  /** Universe slug (always present) */
  universe: string;
  /** Galaxy slug (present for galaxy and star tiers) */
  galaxy?: string;
  /** Star slug (present for star tier only) */
  star?: string;
  /** Detected tier based on segment count */
  tier: Tier;
}

// ---------------------------------------------------------------------------
// JWT Claims
// ---------------------------------------------------------------------------

/** Scoped access entry in the JWT `access` claim */
export interface AccessEntry {
  /** The member's scope, verbatim — the same `universeGalaxyStarId` their `Memberships` row holds.
   *  One fact, one string: nothing derives a second form of it, and both coarse-grained verdicts are
   *  computed from this against the scope being acted on (ADR-015 § *Predicate pair*). */
  authScope: string;
  /** true = admin of this scope; omitted when false (keeps JWT compact).
   *  ⚠️ NOT the Data-plane `admin` grant — that is a permission on an orgTree node, a different
   *  tree entirely. The `scope` qualifier exists because conflating the two has caused a bug. */
  scopeAdmin?: boolean;
}

/**
 * Nebula JWT payload — standard claims + nebula-specific `access`.
 *
 * `email` and `adminApproved` are NOT claims (removed in tasks/archive/nebula-auth-surrogate-sub.md):
 * `email` is a registry-only mutable attribute (resolved via the registry when needed, never keyed
 * off), and `adminApproved` is retired (enforced at MINT — a valid token proves authorized
 * membership by construction, so there is no edge gate to feed).
 */
export interface NebulaJwtPayload {
  /** Issuer — the deployment's platform origin (`hosts.ts`' `platformOrigin`), so each deployment
   *  accepts only its own tokens. */
  iss: string;
  /** Audience — the active universeGalaxyStarId this token is scoped to.
   *  Set from the refresh's required `activeScope`; an impersonation token takes its caller's. */
  aud: string;
  /** Subject — the registry-minted surrogate `sub` (one per email-in-a-scope). */
  sub: string;
  /** Expiration (Unix seconds — JWT NumericDate, ADR-011 carve-out) */
  exp: number;
  /** Issued at (Unix seconds — JWT NumericDate) */
  iat: number;
  /** JWT ID (UUID) */
  jti: string;
  /** Scoped access (one entry per JWT). */
  access: AccessEntry;
  /**
   * The bearer's PUBLIC profile address (a UUID) — a bare, first-party CUSTOM claim (RFC 7519 §4.3),
   * NOT the OIDC `profile` page-URL claim. Sibling of `sub`. The Profile DO's owner check is a direct
   * `claims.profileId === instanceName` equality (no URL to parse). Required: every source a mint reads
   * carries one — the KV refresh record and the registry's identity row, whose `Emails.profileId` is
   * `NOT NULL` — so a subscription row always names its person.
   */
  profileId: string;
  /** Delegation chain per RFC 8693 (optional) */
  act?: ActClaim;
}

// ---------------------------------------------------------------------------
// Registry row shapes (NebulaAuthRegistry SQLite — see schemas.ts)
// Timestamps are ISO 8601 Zulu strings (ADR-011); bearer tokens stored HASHED (`tokenHash`).
// ---------------------------------------------------------------------------

/** `Scopes` row — scope existence (was `Instances`). */
export interface Scope {
  universeGalaxyStarId: string;
}

/** `Emails` row — one per ADDRESS, across every scope that address belongs to. */
export interface EmailRecord {
  /** Opaque surrogate PK (UUID). Everything that must survive an address change references THIS. */
  emailId: string;
  /** MUTABLE current login address, NORMALIZED (lowercased + trimmed). The ONLY copy in the registry. */
  email: string;
  /** Registry-minted PUBLIC display handle (UUID) — a distinct namespace from `sub`, and a property of
   *  the ADDRESS, so every membership this address holds resolves to the same one. */
  profileId: string;
  /** Proof of the MAILBOX — global to the address, never re-proved per scope. */
  emailVerified: boolean;
  createdAt: string;
}

/** `Memberships` row — one per (address, scope); the join table. */
export interface Membership {
  /** Registry-minted surrogate identity key (UUID). The membership key AND the FK every resource,
   *  grant and snapshot records (ADR-013) — so it is never re-keyed. */
  sub: string;
  /** FK → `Emails.emailId`. Never the address itself: an address changes, this does not. */
  emailId: string;
  universeGalaxyStarId: string;
  scopeAdmin: boolean;
  /** When THIS membership was taken up, or absent if never. Distinct from `emailVerified`, which is a
   *  property of the address — an invitation that was never accepted has no value here, and that is
   *  what the Profile's scoped-admin authz check keys on (ADR-012). */
  acceptedAt?: string;
  createdAt: string;
}

/** `RefreshTokenIndex` row — live-token index for reliable KV invalidation. */
export interface RefreshTokenIndex {
  tokenHash: string;
  sub: string;
  expiresAt: string;
}

/** The Workers-KV refresh record (`refresh:{tokenHash}`), read at the edge on refresh — no registry.
 *  `expiresAt` (absolute) is re-applied on a convergence re-put (CF KV drops expirationTtl on put). */
export interface RefreshTokenKV {
  sub: string;
  universeGalaxyStarId: string;
  scopeAdmin: boolean;
  /**
   * Whether this membership has been ACCEPTED — the gate that makes a cookie inert until its holder
   * consents. `handleRefreshToken` refuses to mint on `false`, so a session minted at consume grants
   * nothing until the consent modal's accept endpoint flips the membership and converges this flag
   * (the same way `scopeAdmin` converges).
   *
   * ⚠️ Read as a REFUSAL input only. Acceptance itself is written in exactly one place — the accept
   * endpoint — and this copy is the self-healing denormalization ADR-013 licenses, never a writer.
   */
  accepted: boolean;
  expiresAt: string;
  /** The bearer's `profileId` — carried so the pure-KV refresh mint can emit the `profileId` JWT claim
   *  without a registry read. Written by all three record writers (record/converge/self-heal);
   *  ADR-013's licensed self-healing KV copy. */
  profileId: string;
}

// ---------------------------------------------------------------------------
// Invite wire shapes — the per-invitee contract
// ---------------------------------------------------------------------------

/** One requested invitee. An omitted `scopeAdmin` is a plain member; the bit is honored only when
 *  it is exactly `true` AND the inviter's dominion verdict licenses it — the request selects, the
 *  verdict licenses. `"true"`, `1`, etc. never mint an admin. */
export interface InviteeRequest {
  email: string;
  scopeAdmin?: boolean;
}

/** What happened for one invitee. `invited` is a MINT outcome — sends finish post-return. */
export type InviteOutcome = 'invited' | 'already-member' | 'promoted';

/** Per-invitee success in the caller-facing summary. Carries no token or URL. */
export interface InviteeSummary {
  email: string;
  sub: string;
  outcome: InviteOutcome;
}

/** Per-invitee failure — a malformed entry joins this list; the batch never fails whole. */
export interface InviteeError {
  email: string;
  error: string;
}

/** The caller-facing batch summary. `links` (raw invite URLs per normalized email) appears in test
 *  mode ONLY — it is the sole carrier of the URL past the entry. */
export interface InviteSummary {
  results: InviteeSummary[];
  errors: InviteeError[];
  links?: Record<string, string>;
}

/**
 * Per-invitee MINT result — the registry → entry shape, one step wider than {@link InviteeSummary}.
 * The extra fields exist for the ENTRY's sender alone (`issueInvites` is mint-only; the entry
 * dispatches the mail post-return): `accepted` picks the template and `inviteUrl` is what the
 * `invite-new` letter must deliver. Neither may reach the caller-facing summary — test mode's
 * `links` is the only carrier of the URL.
 */
export interface InviteeMintResult extends InviteeSummary {
  /** Whether this membership was already ACCEPTED at mint time (`Memberships.acceptedAt` set) —
   *  the send helper's template discriminator: accepted → `invite-existing` (a redirect; they can
   *  already log in), pending/new → `invite-new` carrying the fresh link. */
  accepted: boolean;
  /** Absolute magic-link URL backed by the freshly minted invite token. */
  inviteUrl: string;
}

/** One scope a lifecycle hook acts on: its id, and the tier that picks its Durable Object binding. */
export interface ScopeTarget {
  instanceName: string;
  tier: 'universe' | 'galaxy' | 'star';
}

/**
 * What nebula-auth asks the platform to do to Durable Objects it cannot name, since dependency
 * direction keeps it from naming a Galaxy or a Star (ADR-023). The platform answers each through
 * `@rawRpc()`, so neither is a mesh method: `@mesh()` would let any admin wipe a live app without
 * deleting it. Required wherever it is taken, since an optional seam would skip a teardown silently.
 */
export interface ScopeLifecycleHooks {
  /**
   * Wipe each scope's Durable Objects. A deletion calls it on what it removed, and a creation on
   * every scope it wrote, so a new owner starts empty. Each target is attempted on its own; one that
   * fails is logged and the rest still run, so this never rejects. `operationId` names the facade
   * call that ordered it, and rides into each target's teardown marker.
   */
  teardown(targets: ScopeTarget[], cause: 'deletion' | 'creation', operationId: string): Promise<void>;
  /**
   * Wake a galaxy's certificate order (`acme.crm`): the Galaxy records that a pack is wanted and
   * orders it from its own alarm, so a second wake orders nothing. Called after a create, and after
   * any acceptance of a universe membership for each galaxy standing beneath it, a re-accept
   * included; never by a client. Never rejects; a failure is logged naming the galaxy.
   *
   * Acceptance, not the claim or the consume, because a pack is one of the zone's hundred: a claim
   * proves no mailbox, and a consume proves a mailbox but not that anyone meant to open the account.
   */
  orderCertificate(galaxy: string, operationId: string): Promise<void>;
}

/**
 * The refusal an impersonation mint ends a session with: the caller may not act for this subject,
 * or the subject's membership is gone. Detected by `name` plus `terminal`, since a class does not
 * survive a mesh hop (`mesh.md` § *Errors across mesh calls*); every other rejection of a mint is
 * transient.
 */
export class ImpersonationRefusedError extends Error {
  readonly terminal = true;
  constructor(message: string) {
    super(message);
    this.name = 'ImpersonationRefusedError';
  }
}

/** Whether `err` is the {@link ImpersonationRefusedError} a mint ends a session with. */
export function isImpersonationRefused(err: unknown): boolean {
  return err instanceof Error && err.name === 'ImpersonationRefusedError'
    && (err as { terminal?: unknown }).terminal === true;
}

/** What `issueInvites` returns to its entry (never directly to a caller). */
export interface InviteMintResult {
  results: InviteeMintResult[];
  errors: InviteeError[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The reserved platform scope — the ROOT of the scope tree, not an exception to it.
 *  `isAtOrAbove` carries that root branch, so a superuser's dominion everywhere is the ordinary
 *  downward rule applied from the top rather than a special arm at any call site.
 *
 *  The leading underscore is what reserves it: the slug grammar refuses one, so no claim can take
 *  the name and no host label can spell it (ADR-021). `parseId` refuses it too, so
 *  `isPlatformScope` is the one thing that recognizes it. */
export const PLATFORM_SCOPE = '_platform';

/** Singleton instance name for NebulaAuthRegistry */
export const REGISTRY_INSTANCE_NAME = 'registry';

/**
 * Star slugs a stranger may NOT self-claim via `claim-star`: the environment names (ADR-021).
 *
 * A star id's third segment is one slot holding two kinds of value: a **tenant** slug (self-claimed,
 * self-claimed admin identity) or a reserved **environment** name (system-written — `.dev` is born
 * with its galaxy — and no identity minted).
 * There is no structural separator between them — this list is the only thing keeping the two apart.
 *
 * `dev` is in use today: `nebula-client` hardcodes `${galaxy}.dev` as the user-developer's
 * authoring workspace, `Star.resetDevData` gates on `s[2] === 'dev'`, and `#parseScope`'s `isDev`
 * flags the same thing. Without the reject a stranger founds the user-developer's OWN Studio
 * workspace as `scopeAdmin: true` — their Studio then 409s forever, and the squatter's exact-star
 * admin clears `resetDevData`'s `requireDominionHere`, i.e. they can wipe it. The other seven are
 * reserved before anything uses them, because releasing a name later is free and reclaiming one a
 * customer holds is a migration.
 *
 * Reserved **per galaxy**, not globally: uniqueness is on the full `{u}.{g}.{s}`, so every galaxy has
 * its own `{u}.{g}.dev`, and later its own `{u}.{g}.staging`. Only `.dev` is ever created today, by a
 * claim or `createGalaxy`, and `claimStar` refuses every slug here, so the feature that brings in
 * other environments must add their create too.
 */
export const RESERVED_STAR_SLUGS: ReadonlySet<string> = new Set([
  'dev', 'staging', 'prod', 'test', 'preview', 'sandbox', 'qa', 'demo',
]);

/**
 * Universe slugs that cannot be claimed, because each is a host label the platform keeps (ADR-021).
 *
 * A universe's host is its slug directly under `lumenize.dev`, as `acme.lumenize.dev`, and so is
 * every platform host: `platform.lumenize.dev` holds every session and would look exactly like a
 * universe named `platform`. `platform`, `email` and `www` are platform labels. `app`, `auth`,
 * `gateway`, `assets`, `studio` and `pictures` each name a platform service, so each would read as
 * Lumenize's own host on a link; they are kept because releasing a reservation later is free and
 * reclaiming a name a customer holds is a migration. `_`-prefixed names (e.g. `_platform`) are
 * unclaimable already — `SLUG_RE` in `parse-id.ts` rejects a leading underscore — so they need no
 * entry here.
 */
export const RESERVED_UNIVERSE_SLUGS: ReadonlySet<string> = new Set([
  'platform', 'email', 'www', 'app', 'auth', 'gateway', 'assets', 'studio', 'pictures',
]);

/**
 * Nebula's reserved AGENT id — an **actor** id, never a standalone subject: a Nebula-authored
 * message's `actingToken.sub` is always the triggering human, with `{ sub: NEBULA_SUB,
 * profileId: NEBULA_SUB }` prepended as the outermost `act` entry (RFC 8693). Self-describing
 * over a UUID: readable, syntactically not-a-human, and it degrades legibly in a cold record.
 *
 * The id is ALSO Nebula's `profileId` (picked 2026-08-27 — one reserved id, no second constant):
 * a reserved sentinel cannot collide with minted UUIDs (the {@link RESERVED_STAR_SLUGS}
 * precedent — ADR-010's axis is coordination, and reservation IS coordination), and `profileId`
 * is never an authz input, so the shared value leaks nothing. The `Profile` DO whose instance
 * name equals this id SELF-SEEDS the agent's public "Lumenize" fields (profile.ts) — no deploy step.
 *
 * Home: here beside the other reserved names, because the `Profile` DO seeds off it and a
 * package may not import from `apps/nebula`. Browser-safe consumers (deriving `kind` at render)
 * import it via the pure `@lumenize/nebula-auth/claims` subpath, which re-exports it — the ROOT
 * barrel exports the Registry DO and must never enter a client bundle.
 */
export const NEBULA_SUB = 'agent:nebula';

/** Default URL prefix for all auth routes */
export const NEBULA_AUTH_PREFIX = '/auth';

/**
 * What a `MagicLinks` row was issued FOR — a sign-in, a claim, or an invite. Recorded for the
 * activity log and decides nothing: where the consume sends the person is the row's `returnTo`.
 * Explicit rather than inferred from the scope column, which is NULL for the common case.
 */
export type MagicLinkPurpose = 'login' | 'claim' | 'invite';

/**
 * Who created a membership FOR someone else, captured at mint and never rewritten (ADR-013's
 * write-time-pinned attribution). The handles come from the inviter's verified claims; `name` is a
 * value they asserted about themselves, so it is display-only and attributed as sender-supplied
 * wherever it renders. Absent entirely on a membership its holder created themselves.
 */
export interface InvitedByStamp {
  sub?: string;
  name?: string;
  profileId?: string;
}

/**
 * What the Worker needs from RPC 1 of a consume, to decide which cookies to mint and where to land.
 * The registry validates the link and resolves the address's memberships; the Worker owns the token
 * minting because it alone holds the raw values the cookies carry.
 */
export interface ConsumePlan {
  email: string;
  /**
   * The scope the link itself named, if any — a claim's or an invite's. Absent on a plain login link.
   * Its unaccepted membership is the one the link's page accepts. The row's `purpose` decides nothing
   * and stays a recorded fact on `MagicLinks` for the activity log.
   */
  linkScope?: string;
  /** Where the consume sends the person: a scope host the server checked or chose, or Home when absent. */
  returnTo?: string;
  /** Every membership the address holds, most recently created first. */
  memberships: ConsumeMembership[];
}

/**
 * What a link's page shows before anything is consumed. Read by a lookup that writes nothing, so a
 * scanner or an `<img>` loading the page proves no mailbox and creates nothing.
 */
export interface LinkLookup {
  email: string;
  /** The link was already used: its page says so and offers sign-in. */
  spent: boolean;
  /** The membership the page offers to accept: unaccepted, at the scope the link names. */
  pending?: { scope: string; sub: string; invited: boolean; invitedByName?: string };
  /**
   * A `sub` of an accepted membership the address holds, whose Profile the page pre-fills from.
   * Absent when it holds none, so a lookup never reads, and so never creates, a new invitee's Profile.
   */
  acceptedSub?: string;
}

/** One membership in a {@link ConsumePlan} — everything a refresh record needs, plus the acceptance
 *  state that decides whether its cookie will mint anything. */
export interface ConsumeMembership {
  sub: string;
  universeGalaxyStarId: string;
  scopeAdmin: boolean;
  profileId: string;
  accepted: boolean;
}

/** One session the Worker asks the registry to record — the raw token stays Worker-side. */
export interface SessionRecord {
  sub: string;
  tokenHash: string;
}

/**
 * A Workers KV refresh record the Registry composed and the Worker puts. The Worker writes it
 * because the Worker is where the person is, then re-reads the Registry's answer for the hash and
 * deletes its put if the two differ, so a revoke landing between the answer and the put cannot
 * leave a live record nobody indexes.
 */
export interface RefreshPut {
  tokenHash: string;
  record: RefreshTokenKV;
}

/**
 * KV `expirationTtl` (seconds-from-now) from an absolute ISO expiry. CF KV requires ≥ 60s; clamp up so
 * a near-expiry re-put doesn't throw. The absolute expiry is the source of truth (M4) — this only
 * translates it to the seconds-from-now KV wants at write time. Both writers use it: the Worker's
 * puts and `setIdentityAdmin`'s.
 */
export function kvTtlSeconds(expiresAtIso: string): number {
  const seconds = Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000);
  return Math.max(60, seconds);
}

/**
 * Whether a put record still says what the Registry says now — the reap's test. Every field is
 * compared, so a concurrent `setIdentityAdmin` reaps a stale put as surely as a revoke does.
 */
export function sameRefreshRecord(a: RefreshTokenKV | null, b: RefreshTokenKV | null): boolean {
  if (!a || !b) return false;
  return a.sub === b.sub && a.universeGalaxyStarId === b.universeGalaxyStarId
    && a.scopeAdmin === b.scopeAdmin && a.accepted === b.accepted
    && a.expiresAt === b.expiresAt && a.profileId === b.profileId;
}

/**
 * The most galaxies one address may own, counted live at `createGalaxy` and at a claim's
 * acceptance over the address's ACCEPTED admin memberships, less any at the platform root. A
 * runaway stop rather than an anti-abuse guard: it stops a script in a loop, or a bug in our own
 * create path, from spending a budget every customer on the zone shares. It counts galaxies others
 * created under a universe you administer, so the number has headroom. Raise it on request.
 */
export const MAX_GALAXIES_PER_OWNER = 20;

/** The cap's refusal, worded once so both sites say the same thing. */
export const GALAXY_CAP_MESSAGE =
  `One account owner may hold at most ${MAX_GALAXIES_PER_OWNER} apps. Ask us and we will raise it.`;

/** What proved the mailbox behind an acceptance, named in its record. */
export type AcceptanceCredential = 'link' | 'refresh-cookie';

/**
 * What one Accept did, as a value rather than a throw, so the Worker can tell an order still owed
 * from a refusal (`raw-comm.md` § *Errors over raw Workers RPC*).
 *
 * - `accepted` — the flip landed. `teardown` is non-empty only on a claim's FIRST acceptance and
 *   names every scope the claim wrote, which the Worker wipes before it answers. `sessions` are the
 *   KV records the Worker re-puts so the cookies stop being inert.
 * - `already-accepted` — nothing changed, and nothing is torn down.
 * - `refused` — the cap; the membership stays unaccepted.
 * - `not-found` — no such membership, which arises when a deletion lands between the page's load
 *   and its Accept.
 *
 * `galaxies` names every live galaxy beneath a universe membership, accepted or already, so a
 * caller can order each one's certificate; ordering is idempotent, and nothing stores which galaxy
 * a claim wrote.
 */
export type AcceptanceOutcome =
  | {
    outcome: 'accepted'; scope: string; accepted: string[];
    sessions: RefreshPut[]; teardown: ScopeTarget[]; galaxies: string[];
  }
  | { outcome: 'already-accepted'; scope: string; galaxies: string[] }
  | { outcome: 'refused'; reason: 'galaxy_cap'; message: string }
  | { outcome: 'not-found' };

/**
 * Most cookies one consume will set. A third party can grow a victim's membership count for free
 * (`claimStar` is open self-signup, `issueInvites` is peer-reachable), so the fan-out is bounded
 * rather than trusted; past the cap the Home tree still lists the scope, and clicking it sends a
 * fresh scoped link. Chosen to sit far below any browser's per-domain cookie ceiling while being
 * more memberships than a pre-alpha person plausibly holds.
 */
export const MINT_ALL_COOKIE_CAP = 24;

/**
 * A node in the Home screen's scope tree — a membership, or a scope beneath an admin membership.
 * `children` is present only where the walk descended; `childCount` says how many lie past the
 * frontier, so the client can render "12 more" without the server having read them.
 */
export interface ScopeNode {
  scope: string;
  tier: Tier;
  /** Present on a membership row; absent on a descendant reached through one. */
  scopeAdmin?: boolean;
  /** Present on a membership row: whether its holder has taken it up. */
  accepted?: boolean;
  /**
   * Whether this membership was INVITE-minted — the consent modal's flavour discriminator.
   *
   * ⚠️ **A boolean, because the attribution fields cannot carry this.** The flavour used to be read
   * off `invitedByName`/`invitedByProfileId`, and both are optional: an inviter who supplied no
   * display name, on a token carrying no `profileId`, produced a stamped row whose every stamp field
   * was null — and `JSON.stringify` drops undefined keys, so the wire shape was byte-identical to a
   * self-claim. The invitee would then meet "Only accept if you initiated this signup" for something
   * a third party initiated: the wrong warning, silently. This says the fact directly.
   */
  invited?: boolean;
  /** Present on an INVITED membership — the consent modal's inputs (ADR-013 attribution). */
  invitedByName?: string;
  invitedByProfileId?: string;
  children?: ScopeNode[];
  /** Descendants NOT included, whether because of the budget or because nothing was fetched. */
  childCount?: number;
}

/** One address of the person, with everything they reach through it. */
export interface EmailScopes {
  email: string;
  memberships: ScopeNode[];
}

/** What the Home screen renders from — one call, the whole picture. */
export interface ScopeSummary {
  emails: EmailScopes[];
}

/**
 * Most tree nodes one summary reads. The bound is on the READ, not just the response: each level is
 * fetched with `LIMIT budget + 1`, so a superuser — whose subtree is every scope in the system —
 * costs the same as anyone else rather than scanning the table to serve a small body.
 */
export const SCOPE_TREE_NODE_BUDGET = 50;

/** Longest inviter display name stamped on a membership. Generous for real names, short enough
 *  that the consent modal's own copy cannot be pushed off screen by a hostile one. */
export const INVITER_NAME_MAX = 64;

/**
 * Make an inviter-supplied display name safe to store and to render in the invitee's consent modal.
 *
 * ⚠️ **The adversary is the person who supplied it.** This value is the only identity that modal
 * shows, and the modal exists to help someone decide whether they know who invited them — so a name
 * is capped (a long one could push the modal's own copy off screen) and stripped of control
 * characters (which could reflow that copy, or smuggle a second line that reads as ours). What it is
 * NOT is validated for truthfulness: a display name is self-asserted at its source, which is why the
 * modal attributes it as sender-supplied and pairs it with the target scope, a value the inviter
 * cannot choose. Returns `undefined` for anything that survives as empty, so an unusable name simply
 * yields no name rather than an empty-looking one.
 */
export function sanitizeInviterName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the whole point
  return name.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, INVITER_NAME_MAX) || undefined;
}

/** `instanceName` for mail carrying a link that names no scope. Leading `_` is unreachable for a
 *  real slug — `parse-id`'s `SLUG_RE` requires `[a-z0-9]` first — so this can never collide. */
export const SCOPELESS_INSTANCE_TAG = '_scopeless';

/** Access token lifetime in seconds (15 minutes) — the DEFAULT and the enforced ceiling. */
export const ACCESS_TOKEN_TTL = 900;

/**
 * Below this, a requested `ttlSeconds` is warned about but **still honoured** — advisory, never
 * enforced. Contrast {@link ACCESS_TOKEN_TTL}, which IS enforced as the ceiling; the name carries
 * that distinction on purpose.
 *
 * **4× `@lumenize/mesh`'s {@link TOKEN_REFRESH_AHEAD_SECONDS}**, and DERIVED from it rather than
 * restated — a token at or below that window is *born* already due for refresh, so it re-mints
 * continuously; 4× leaves most of a token's life outside it. Deriving is the point: the relation was
 * previously prose against an inline `exp - 30` literal in another package, so changing that number
 * would have silently falsified this one.
 *
 * ⚠️ Deliberately NOT a floor. A floor would make an expiring-token test unreachable without a
 * test-mode bypass, and it would not address the second hazard at all — which is semantic, not a
 * range problem: a shorter TTL shortens only the SUBJECT-side revocation leash. The caller-side
 * gates on the impersonation mint read the caller's own token, never the registry, so a demoted
 * admin stays bounded by their parent token's lifetime plus KV propagation regardless of how short
 * the minted token is.
 */
export const RECOMMENDED_MIN_TTL_SECONDS = 4 * TOKEN_REFRESH_AHEAD_SECONDS;

/** Refresh token lifetime in seconds (30 days) */
export const REFRESH_TOKEN_TTL = 2592000;

/** Magic link lifetime in seconds (30 minutes) */
export const MAGIC_LINK_TTL = 1800;

/** Invite token lifetime in seconds (7 days) */
export const INVITE_TTL = 604800;

/**
 * Signup-ticket lifetime in seconds (15 minutes).
 *
 * Deliberately far shorter than {@link MAGIC_LINK_TTL}: a magic link has to survive sitting in a
 * mailbox, whereas a ticket authorizes the screen the browser is being redirected to right now. The
 * only thing it has to outlast is a person choosing a name for their workspace.
 */
export const SIGNUP_TICKET_TTL = 900;

/**
 * The cookie carrying a signup ticket to the signup page's claim, on the platform host. `__Host-`
 * like the refresh cookies, so no other host can plant one for the claim to spend.
 */
export const SIGNUP_TICKET_COOKIE = '__Host-signup-ticket';

/**
 * What a coming-soon affordance may report, as a closed set.
 *
 * ⚠️ **A fixed server-side enum, never free text.** The value is written to a log by an
 * unauthenticated route, so accepting arbitrary strings would make it a log-injection faucet and an
 * unbounded-cardinality one. A tag this list does not contain is refused rather than recorded — an
 * unrecognised stub is a client bug worth a 400, not a datapoint worth keeping.
 */
export const COMING_SOON_TAGS = [
  'universe-management',
  'email-management',
  'billing',
  'team-settings',
] as const;

export type ComingSoonTag = (typeof COMING_SOON_TAGS)[number];

/** How often the registry sweeps its expired token rows (1 hour).
 *
 *  ⚠️ This period tracks STORAGE ACCUMULATION, never a correctness deadline — every row the sweep
 *  removes is already inert on lookup, so a late tick costs disk and nothing else. Do not shorten it
 *  reflexively: the registry is the system's one singleton, so each tick is a wake it pays for
 *  (ADR-018), and an earlier 5-minute value was inherited from a mechanism that no longer exists. */
export const SWEEP_INTERVAL_SECONDS = 3600;


