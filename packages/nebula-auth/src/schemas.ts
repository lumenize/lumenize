/**
 * SQL schema definitions for the NebulaAuthRegistry (the ONE singleton DO that now owns all auth
 * state — the per-scope NebulaAuth DO is dissolved by tasks/nebula-auth-surrogate-sub.md).
 *
 * Five registry tables:
 *   Scopes            — scope-existence registry (renamed from `Instances`) + Universe consent.
 *   Identities        — person-in-a-scope (merged `Emails` + `Subjects`), keyed by surrogate `sub`.
 *   RefreshTokenIndex — live-token index (tokenHash → sub) for reliable KV invalidation.
 *   MagicLinks        — login channel (moved from per-scope NebulaAuth), hashed token.
 *   InviteTokens      — login channel (moved from per-scope NebulaAuth), hashed token, single-use.
 *
 * Conventions (see .claude/rules/durable-objects.md § SQL naming + write-cost):
 *   PascalCase tables, camelCase columns. WITHOUT ROWID on every TEXT-PK table (avoids the hidden
 *   rowid + duplicate index). Timestamps are ISO 8601 Zulu TEXT (ADR-011), never epoch number.
 *   Bearer tokens are stored as a one-way `tokenHash`, never raw (ADR: nebula-auth-surrogate-sub).
 *
 * The refresh-token HOT record lives in Workers KV (`refresh:{tokenHash}`), NOT here — this DO keeps
 * only the `RefreshTokenIndex` so the single-writer can enumerate+invalidate a sub's tokens.
 *
 * @see tasks/nebula-auth-surrogate-sub.md § The schema
 */
import type { SQLSchemaMigration } from '@lumenize/sql-migrations';

/** Scope-existence registry (was `Instances`). Existence is INDEPENDENT of membership — a
 *  wildcard-managed child scope has a row here and zero `Identities`. No `createdAt` (YAGNI).
 *  ⚠️ Migration 1 also created an `improveProductConsent` column; migration 8 DROPS it (the consent
 *  feature was removed 2026-07-21 as YAGNI — zero consumers). This literal is migration 1's frozen
 *  history, so the column stays here; the live table has only `universeGalaxyStarId`. */
export const SCOPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS Scopes (
  universeGalaxyStarId TEXT PRIMARY KEY,
  improveProductConsent INTEGER
) WITHOUT ROWID
`;

/** Drop the unused data-use-consent column (feature removed 2026-07-21 — YAGNI, no consumer ever
 *  built). Append-only: migration 1's literal is left intact, so a fresh DB creates the column and
 *  this immediately drops it, matching an existing DB's end state exactly. */
export const SCOPES_DROP_CONSENT = `ALTER TABLE Scopes DROP COLUMN improveProductConsent`;

/** Person-in-a-scope (merged `Emails` + `Subjects`), keyed by the registry-minted surrogate `sub`.
 *  `UNIQUE (email, universeGalaxyStarId)` is one identity per email per scope AND serves the
 *  `WHERE email = ?` discover lookup by leftmost-prefix — so there is deliberately NO separate email
 *  index. `email` is stored lowercased (see the registry mint/change paths). `profileId` is the
 *  minted-with-`sub` PUBLIC address (a UUID, distinct namespace from `sub`) — see the reverse index
 *  below + tasks/nebula-profile-store.md. */
export const IDENTITIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS Identities (
  sub TEXT PRIMARY KEY,
  profileId TEXT NOT NULL,
  universeGalaxyStarId TEXT NOT NULL,
  email TEXT NOT NULL,
  isAdmin INTEGER NOT NULL DEFAULT 0,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE (email, universeGalaxyStarId)
) WITHOUT ROWID
`;

/** Reverse lookup `profileId → scopes` — serves the Profile DO's scoped-admin authz check
 *  (`SELECT universeGalaxyStarId FROM Identities WHERE profileId = ?`; tasks/nebula-profile-store.md).
 *  `profileId ← 1..N subs` (P2 unification substrate), so this is not unique. */
export const IDENTITIES_PROFILE_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_Identities_profileId ON Identities(profileId)
`;

/** Live refresh-token index → reliable invalidation. The single-writer looks tokens up by `tokenHash`
 *  (logout) and enumerates by `sub` (isAdmin-convergence / user-removal), so PK `tokenHash` + a
 *  secondary index on `sub`. `expiresAt` is the token's absolute expiry, re-applied to the KV record
 *  on a convergence re-put (CF KV drops expirationTtl across a put). */
export const REFRESH_TOKEN_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS RefreshTokenIndex (
  tokenHash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  expiresAt TEXT NOT NULL
) WITHOUT ROWID
`;

export const REFRESH_TOKEN_INDEX_SUB_INDEX = `
CREATE INDEX IF NOT EXISTS idx_RefreshTokenIndex_sub ON RefreshTokenIndex(sub)
`;

/** Magic-link login channel (moved from per-scope NebulaAuth). Token stored HASHED. ~30m TTL,
 *  reusable within the window (scanner-safe), swept on `expiresAt`. */
export const MAGIC_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS MagicLinks (
  tokenHash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  universeGalaxyStarId TEXT NOT NULL,
  expiresAt TEXT NOT NULL
) WITHOUT ROWID
`;

/** Invite login channel (moved from per-scope NebulaAuth). Token stored HASHED. Single-use
 *  (deleted on claim). Swept on `expiresAt`. */
export const INVITE_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS InviteTokens (
  tokenHash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  universeGalaxyStarId TEXT NOT NULL,
  expiresAt TEXT NOT NULL
) WITHOUT ROWID
`;

/**
 * The registry's schema as an ordered, append-only migration list, run by `@lumenize/sql-migrations`
 * in the `NebulaAuthRegistry` constructor (id-gated, atomic).
 *
 * **Greenfield RESET (tasks/nebula-auth-surrogate-sub.md):** this replaces the old `Instances`/`Emails`
 * baseline. It is safe to reset the id sequence ONLY because that task performs a full system WIPE
 * (CF-dashboard worker-delete clears DO storage → no prior applied ids survive) and local vitest is
 * always a fresh deploy. **From here on APPEND-ONLY:** never edit, reorder, or reuse an applied id —
 * add a new id for any further change.
 *
 * **Pre-wipe baseline exception (tasks/nebula-profile-store.md, 2026-07-14):** `Identities.profileId`
 * is folded into the id-2 baseline `IDENTITIES_SCHEMA` above (NOT an append-only `ALTER`) — permitted
 * ONLY because the surrogate-sub wipe that resets this sequence hasn't deployed yet, so no live DO has
 * applied id 2. Its reverse index is appended as id 7. ⚠️ A local `wrangler dev` DO that already ran
 * id 2 won't re-run it (→ `profileId` INSERTs fail) — `rm -rf .wrangler` to recover (fresh vitest is
 * unaffected). Once the wipe deploys, this exception closes and the list is APPEND-ONLY again.
 */
export const REGISTRY_MIGRATIONS: SQLSchemaMigration[] = [
  { idMonotonicInc: 1, description: 'Scopes table (scope-existence registry + Universe consent)', sql: SCOPES_SCHEMA },
  { idMonotonicInc: 2, description: 'Identities table (person-in-a-scope, surrogate sub PK, profileId)', sql: IDENTITIES_SCHEMA },
  { idMonotonicInc: 3, description: 'RefreshTokenIndex table', sql: REFRESH_TOKEN_INDEX_SCHEMA },
  { idMonotonicInc: 4, description: 'RefreshTokenIndex(sub) index', sql: REFRESH_TOKEN_INDEX_SUB_INDEX },
  { idMonotonicInc: 5, description: 'MagicLinks table (login channel, hashed)', sql: MAGIC_LINKS_SCHEMA },
  { idMonotonicInc: 6, description: 'InviteTokens table (login channel, hashed, single-use)', sql: INVITE_TOKENS_SCHEMA },
  { idMonotonicInc: 7, description: 'Identities(profileId) index (profile-store reverse lookup)', sql: IDENTITIES_PROFILE_ID_INDEX },
  { idMonotonicInc: 8, description: 'Drop Scopes.improveProductConsent (consent feature removed)', sql: SCOPES_DROP_CONSENT },
];
