/**
 * SQL schema definitions for the NebulaAuthRegistry (the ONE singleton DO that owns all auth state).
 *
 * Six registry tables:
 *   Scopes            — scope-existence registry. Existence is INDEPENDENT of membership.
 *   Emails            — one row per ADDRESS: the address itself, its `profileId`, mailbox-proof state.
 *   Memberships       — one row per (address, scope): the join table, keyed by surrogate `sub`.
 *   RefreshTokenIndex — live-token index (tokenHash → sub) for reliable KV invalidation.
 *   MagicLinks        — login channel, hashed token, ~30m TTL.
 *   InviteTokens      — login channel, hashed token, single-use, 7d TTL.
 *
 * **Why `Emails` and `Memberships` are separate, since one table would be simpler:** a person's
 * `profileId` is a property of their ADDRESS, not of any one scope they joined. Holding it on the join
 * row would make "one human, one profile" an *emergent* property of N rows agreeing — which yields
 * derived canonical-ness, a first-mover race between two paths that see the same address, and N
 * uncoordinated copies of the address that an email change has to update in lockstep. Splitting makes
 * each a structural fact: one address, one row, one `profileId`, and a change is a single-row UPDATE.
 *
 * Conventions (see .claude/rules/durable-objects.md § SQL naming + write-cost):
 *   PascalCase tables, camelCase columns. WITHOUT ROWID on every TEXT-PK table (avoids the hidden
 *   rowid + duplicate index). Timestamps are ISO 8601 Zulu TEXT (ADR-011), never epoch number.
 *   Booleans are INTEGER + a CHECK — SQLite has no boolean type, and a CHECK cannot be retrofitted
 *   without a full table rebuild, so it is added at creation or never.
 *   Bearer tokens are stored as a one-way `tokenHash`, never raw.
 *
 * The refresh-token HOT record lives in Workers KV (`refresh:{tokenHash}`), NOT here — this DO keeps
 * only `RefreshTokenIndex` so the single-writer can enumerate and invalidate one person's tokens.
 */
import type { SQLSchemaMigration } from '@lumenize/sql-migrations';

/** Scope-existence registry. Existence is INDEPENDENT of membership — an admin-created child scope has
 *  a row here and zero `Memberships`, because the creator's own wildcard pattern already reaches it.
 *  Four readers need this row and none of them is access control: slug uniqueness, parent-exists,
 *  enumeration (so an admin can find a scope they hold no membership in), and the deletion cascade. */
export const SCOPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS Scopes (
  universeGalaxyStarId TEXT PRIMARY KEY
) WITHOUT ROWID
`;

/** One row per ADDRESS, behind an opaque surrogate PK (ADR-010: keys are random opaque values, never a
 *  mutable natural attribute). The address is a plain attribute here, so changing it is a one-row,
 *  one-column UPDATE with no cascade — nothing keys or FKs on an address.
 *
 *  ⚠️ `email` is stored NORMALIZED (lowercased + trimmed) on EVERY path that writes it. That is not
 *  tidiness: "same address, any scope → same profileId" is structural only because one address yields
 *  one row, so a stray leading space at mint that a trimmed login cannot match would silently split one
 *  person into two rows with two profileIds — and that split is now GLOBAL, not per-scope.
 *
 *  `profileId` is the PUBLIC display handle (a distinct namespace from `sub`) and is real from the
 *  moment the row exists — there is no provisional state and no promotion step. */
export const EMAILS_SCHEMA = `
CREATE TABLE IF NOT EXISTS Emails (
  emailId       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  profileId     TEXT NOT NULL,
  emailVerified INTEGER NOT NULL DEFAULT 0 CHECK (emailVerified IN (0, 1)),
  createdAt     TEXT NOT NULL
) WITHOUT ROWID
`;

/** Reverse lookup `profileId → addresses`, for the Profile DO's scoped-admin authz check (ADR-012).
 *  Indexed rather than scanned because that check sits permanently on an AUTHZ path and `Emails` is
 *  never swept, so the alternative is an unbounded scan on the system's one singleton (ADR-018). */
export const EMAILS_PROFILE_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_Emails_profileId ON Emails(profileId)
`;

/** One row per (address, scope) — the join table, keyed by the registry-minted surrogate `sub`.
 *  `sub` is the membership key AND the FK every resource/grant/snapshot records (ADR-013), so it must
 *  never be re-keyed. `UNIQUE (emailId, universeGalaxyStarId)` is one membership per address per scope
 *  AND serves the `WHERE emailId = ?` lookup by leftmost prefix — hence no separate index.
 *
 *  ⚠️ `emailVerified` (on `Emails`) and `acceptedAt` (here) answer DIFFERENT questions, and one column
 *  cannot do both: proving control of a mailbox is a property of the ADDRESS and should not be re-proved
 *  scope by scope, while whether a membership was ever taken up is per-MEMBERSHIP. An invitation that
 *  was never accepted has `acceptedAt IS NULL` — which is what the scoped-admin authz check keys on. */
export const MEMBERSHIPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS Memberships (
  sub                  TEXT PRIMARY KEY,
  emailId              TEXT NOT NULL,
  universeGalaxyStarId TEXT NOT NULL,
  scopeAdmin           INTEGER NOT NULL DEFAULT 0 CHECK (scopeAdmin IN (0, 1)),
  acceptedAt           TEXT,
  createdAt            TEXT NOT NULL,
  UNIQUE (emailId, universeGalaxyStarId)
) WITHOUT ROWID
`;

/** Live refresh-token index → reliable invalidation. The single-writer looks tokens up by `tokenHash`
 *  (logout) and enumerates by `sub` (scopeAdmin-convergence / revocation), so PK `tokenHash` + a secondary
 *  index on `sub`. `expiresAt` is the token's absolute expiry, re-applied to the KV record on a
 *  convergence re-put (CF KV drops expirationTtl across a put).
 *
 *  ⚠️ On a KV MISS this table is the source of truth — `getRefreshRecord` reconstructs the record from
 *  it — so an index row outliving its KV record is a LIVE token that comes back, not a harmless
 *  leftover. A revoke must therefore never remove a row whose KV record it did not delete. */
export const REFRESH_TOKEN_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS RefreshTokenIndex (
  tokenHash TEXT PRIMARY KEY,
  sub       TEXT NOT NULL,
  expiresAt TEXT NOT NULL
) WITHOUT ROWID
`;

export const REFRESH_TOKEN_INDEX_SUB_INDEX = `
CREATE INDEX IF NOT EXISTS idx_RefreshTokenIndex_sub ON RefreshTokenIndex(sub)
`;

/** Magic-link login channel. Token stored HASHED. ~30m TTL, reusable within the window (scanner-safe).
 *
 *  ⚠️ Holds the BARE ADDRESS, and it must NOT be "fixed" to an `emailId`. Two reasons, and the second
 *  is the load-bearing one: (1) ADR-010's replication rule permits a mutable value in a token whose
 *  expiry bounds the staleness, and 30 minutes against an address that changes once in years qualifies;
 *  (2) resolving by ADDRESS is what makes a stale link fail CLOSED after an email change — no membership
 *  matches, so the link is dead. An `emailId` never goes stale, so it would keep resolving to whatever
 *  address the person holds now, minting a session for whoever still reads the old mailbox. */
export const MAGIC_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS MagicLinks (
  tokenHash            TEXT PRIMARY KEY,
  email                TEXT NOT NULL,
  universeGalaxyStarId TEXT NOT NULL,
  expiresAt            TEXT NOT NULL
) WITHOUT ROWID
`;

/** Invite login channel. Token stored HASHED. Single-use (deleted on claim), 7d TTL.
 *
 *  ⚠️ Holds the BARE ADDRESS for the same two reasons as `MagicLinks`, and the fail-closed half matters
 *  MORE here: consuming an invite is a full login, the TTL is 7 days rather than 30 minutes, and an
 *  unconsumed invite is never deleted before it expires. */
export const INVITE_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS InviteTokens (
  tokenHash            TEXT PRIMARY KEY,
  email                TEXT NOT NULL,
  universeGalaxyStarId TEXT NOT NULL,
  expiresAt            TEXT NOT NULL
) WITHOUT ROWID
`;

/**
 * The registry's schema as an ordered, append-only migration list, run by `@lumenize/sql-migrations`
 * in the `NebulaAuthRegistry` constructor (id-gated, atomic).
 *
 * **This is a COLLAPSED BASELINE.** It replaces a longer list whose accumulated create-then-alter pairs
 * described the same end state less clearly. Collapsing is licensed only because a full system wipe
 * removes every DO's storage, so no live DB has applied the ids it replaces.
 *
 * ⚠️ **The ids start at 9, ABOVE the replaced list's highest id (8) — deliberately, and they must never
 * be renumbered down to 1.** Ids are a high-water mark, not list positions: the runner selects on
 * `id > marker`, so a storage whose marker is already 8 would match NOTHING against a 1-based baseline
 * and return `{rowsRead: 0, rowsWritten: 0}` — byte-identical to a healthy already-current construct,
 * with no error and no signal, surfacing much later as `no such table` from an unrelated method.
 * Numbering above the mark makes that failure impossible rather than merely unlikely. Full reasoning in
 * `runAll`'s JSDoc; the convention is in `.claude/rules/durable-objects.md` § Initialization.
 *
 * **From here on APPEND-ONLY:** never edit, reorder, or reuse an applied id — add a new, higher id.
 */
export const REGISTRY_MIGRATIONS: SQLSchemaMigration[] = [
  { idMonotonicInc: 9, description: 'Scopes table (scope-existence registry)', sql: SCOPES_SCHEMA },
  { idMonotonicInc: 10, description: 'Emails table (one row per address; owns profileId)', sql: EMAILS_SCHEMA },
  { idMonotonicInc: 11, description: 'Emails(profileId) index (Profile scoped-admin authz lookup)', sql: EMAILS_PROFILE_ID_INDEX },
  { idMonotonicInc: 12, description: 'Memberships table (one per address+scope, surrogate sub PK)', sql: MEMBERSHIPS_SCHEMA },
  { idMonotonicInc: 13, description: 'RefreshTokenIndex table', sql: REFRESH_TOKEN_INDEX_SCHEMA },
  { idMonotonicInc: 14, description: 'RefreshTokenIndex(sub) index', sql: REFRESH_TOKEN_INDEX_SUB_INDEX },
  { idMonotonicInc: 15, description: 'MagicLinks table (login channel, hashed)', sql: MAGIC_LINKS_SCHEMA },
  { idMonotonicInc: 16, description: 'InviteTokens table (login channel, hashed, single-use)', sql: INVITE_TOKENS_SCHEMA },
];
