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
 * `profileId` is **optional**, matching every source of it (`NebulaJwtPayload.profileId` is optional at
 * every layer, and ADR-013 makes it display-only).
 *
 * ⚠️ **Local, deliberately.** `@lumenize/crypto` is a shared primitive package with its own consumers; widening
 * its type is out of scope. ⚠️ **Not a pending reconciliation** — `tasks/archive/nebula-auth-decouple-from-auth.md`
 * considered folding this widening into the shared package and REJECTED it (widening now buys a shape
 * about to change); ADR-016 / `nebula-pre-alpha.md` schema-surgery item 6 is where `projectActClaim`'s
 * deletion actually lives, as `resources.ts` already cites. ⚠️ `apps/nebula/src/resources.ts`
 * keeps importing the **narrow** `@lumenize/crypto` type: its `changedBy` is a persistence boundary, and
 * declaring an optional `profileId` there is the ADR-001 divergence `projectActClaim` exists to
 * prevent. **The type system is not a guard across that seam** — the widened shape is structurally
 * assignable to the narrow one, so nothing errors if the wrong import is chosen; the projection is the
 * sole enforcement.
 *
 * Recursive per RFC 8693, outermost = current. This endpoint's mint never nests (the root-identity gate
 * refuses an act-bearing caller and the builder writes a flat actor), but depth ≤ 1 is a property of
 * THAT mint, not of the system — a platform prepending itself as an additional actor does nest.
 */
export interface ActClaim {
  sub: string;
  /** The actor's PUBLIC profile address — display-only (ADR-013). Omitted when the actor's own token
   *  carries no `profileId` claim. */
  profileId?: string;
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
  /** Issuer — always NEBULA_AUTH_ISSUER */
  iss: string;
  /** Audience — the active universeGalaxyStarId this token is scoped to.
   *  Set from the required `activeScope` field in the refresh / mint-narrower-token request body. */
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
   * `claims.profileId === instanceName` equality (no URL to parse). Optional: a KV record predating the
   * profileId rollout mints gracefully without it. tasks/archive/nebula-profile-store.md § JWT decisions.
   */
  profileId?: string;
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
  expiresAt: string;
  /** The bearer's `profileId` — carried so the pure-KV refresh mint can emit the `profileId` JWT claim
   *  without a registry read. Written by all three record writers (record/converge/self-heal);
   *  ADR-013's licensed self-healing KV copy. */
  profileId: string;
}

/** `MagicLinks` row — login channel, token stored HASHED. */
export interface MagicLink {
  tokenHash: string;
  email: string;
  universeGalaxyStarId: string;
  expiresAt: string;
}

/** `InviteTokens` row — login channel, token stored HASHED. Reusable within its TTL (scanner-safe,
 *  matching `MagicLinks`); rows die only at the expiry sweep, never on consume. */
export interface InviteToken {
  tokenHash: string;
  email: string;
  universeGalaxyStarId: string;
  expiresAt: string;
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
  /** Absolute accept-invite URL backed by the freshly minted token. */
  inviteUrl: string;
}

/** What `issueInvites` returns to its entry (never directly to a caller). */
export interface InviteMintResult {
  results: InviteeMintResult[];
  errors: InviteeError[];
}

/** Discovery result returned by POST {prefix}/discover. `sub`-free by design — `discover` is
 *  unauthenticated/unthrottled, so it must never leak the surrogate identity key. */
export interface DiscoveryEntry {
  universeGalaxyStarId: string;
  scopeAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The reserved platform scope — the ROOT of the scope tree, not an exception to it.
 *  `isAtOrAbove` carries that root branch, so a superuser's dominion everywhere is the ordinary
 *  downward rule applied from the top rather than a special arm at any call site. */
export const PLATFORM_SCOPE = 'nebula-platform';

/** Singleton instance name for NebulaAuthRegistry */
export const REGISTRY_INSTANCE_NAME = 'registry';

/**
 * Star slugs a stranger may NOT self-claim via `claim-star`.
 *
 * A star id's third segment is one slot holding two kinds of value: a **tenant** slug (self-claimed,
 * self-claimed admin identity) or a reserved **environment** name (admin-created and no identity minted, via `createStar`).
 * There is no structural separator between them — this list is the only thing keeping the two apart.
 *
 * `dev` is reserved by structure, not by policy: `nebula-client` hardcodes `${galaxy}.dev` as the
 * user-developer's authoring workspace, `Star.resetDevData` gates on `s[2] === 'dev'`, and
 * `#parseScope`'s `isDev` flags the same thing. Without the reject a stranger founds the
 * user-developer's OWN Studio workspace as `scopeAdmin: true` — their Studio then 409s forever, and the
 * squatter's exact-star admin clears `resetDevData`'s `requireDominionHere`, i.e. they can wipe it.
 *
 * Reserved **per galaxy**, not globally: uniqueness is on the full `{u}.{g}.{s}`, so every galaxy has
 * its own `{u}.{g}.dev`. Extend this with any environment name the Galaxy collapse pins for its
 * `{u}.{g}.{env}` cast (`staging`/`prod`), for the same reason.
 */
export const RESERVED_STAR_SLUGS: ReadonlySet<string> = new Set(['dev']);

/** Default URL prefix for all auth routes */
export const NEBULA_AUTH_PREFIX = '/auth';

/**
 * The auth routes whose URL carries the `instanceName` segment. Its job is to type
 * `instanceAuthUrl`'s `route` parameter: adding a route here is a deliberate one-line act, while
 * mistyping one at a call site is a compile error rather than a silently-404ing link in an email.
 *
 * ⚠️ **Re-derived 2026-07-31, and the old rationale is DEAD — do not restore it.** This used to be
 * the single source for *building* those URLs **and** for *recognizing* them: `NebulaEmailSender`
 * tagged outgoing mail by matching a URL's route against this list, so a route missing from it
 * shipped untagged (that is how invite mail shipped untagged, 2026-07-30). **The sender no longer
 * parses URLs at all** — `EmailMessage.instanceName` is required and stamped directly — so the
 * recognize-side is gone and with it the fail-apart-silently hazard. The list survives on the
 * narrower, still-real construction-typing job above, not on that one.
 */
export const INSTANCE_BEARING_ROUTES = ['magic-link', 'accept-invite'] as const;
export type InstanceBearingRoute = typeof INSTANCE_BEARING_ROUTES[number];

/**
 * Build an instance-bearing auth URL: `${origin}/auth/${instanceName}/${route}?${query}`.
 *
 * ⚠️ Use this rather than interpolating the path by hand — the type of `route` is what forces a new
 * instance-bearing route to be declared above, so a typo cannot become a live link in an email.
 */
export function instanceAuthUrl(
  origin: string,
  instanceName: string,
  route: InstanceBearingRoute,
  query: Record<string, string>,
): string {
  const qs = new URLSearchParams(query).toString();
  return `${origin}${NEBULA_AUTH_PREFIX}/${instanceName}/${route}${qs ? `?${qs}` : ''}`;
}

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
 * gates on `/mint-narrower-token` read the caller's own token, never the registry, so a demoted
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

/** How often the registry sweeps its expired token rows (1 hour).
 *
 *  ⚠️ This period tracks STORAGE ACCUMULATION, never a correctness deadline — every row the sweep
 *  removes is already inert on lookup, so a late tick costs disk and nothing else. Do not shorten it
 *  reflexively: the registry is the system's one singleton, so each tick is a wake it pays for
 *  (ADR-018), and an earlier 5-minute value was inherited from a mechanism that no longer exists. */
export const SWEEP_INTERVAL_SECONDS = 3600;

/** JWT issuer */
export const NEBULA_AUTH_ISSUER = 'https://nebula.lumenize.com';
