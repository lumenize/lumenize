/**
 * SQL schema definitions for NebulaAuth DO tables
 *
 * Forked from @lumenize/auth schemas. Key difference: no authorizedActors
 * TEXT column on Subjects (uses junction table instead, same as auth).
 *
 * All tables use WITHOUT ROWID for TEXT PKs to avoid redundant rowid.
 * Naming: PascalCase tables, camelCase columns.
 *
 * @see tasks/nebula-auth.md § Data Model
 */
import type { SQLSchemaMigration } from '@lumenize/sql-migrations';
import { PLATFORM_INSTANCE_NAME } from './types';

export const SUBJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS Subjects (
  sub TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  adminApproved INTEGER NOT NULL DEFAULT 0,
  isAdmin INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  lastLoginAt INTEGER
) WITHOUT ROWID
`;

export const SUBJECTS_IS_ADMIN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_Subjects_isAdmin ON Subjects(sub) WHERE isAdmin = 1
`;

export const MAGIC_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS MagicLinks (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID
`;

export const MAGIC_LINKS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_MagicLinks_email ON MagicLinks(email)
`;

export const INVITE_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS InviteTokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
) WITHOUT ROWID
`;

export const INVITE_TOKENS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_InviteTokens_email ON InviteTokens(email)
`;

export const REFRESH_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS RefreshTokens (
  tokenHash TEXT PRIMARY KEY,
  subjectId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (subjectId) REFERENCES Subjects(sub) ON DELETE CASCADE
) WITHOUT ROWID
`;

export const REFRESH_TOKENS_SUBJECT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_RefreshTokens_subjectId ON RefreshTokens(subjectId)
`;

export const REFRESH_TOKENS_EXPIRES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_RefreshTokens_expiresAt ON RefreshTokens(expiresAt)
`;

export const AUTHORIZED_ACTORS_SCHEMA = `
CREATE TABLE IF NOT EXISTS AuthorizedActors (
  principalSub TEXT NOT NULL,
  actorSub TEXT NOT NULL,
  PRIMARY KEY (principalSub, actorSub),
  FOREIGN KEY (principalSub) REFERENCES Subjects(sub) ON DELETE CASCADE,
  FOREIGN KEY (actorSub) REFERENCES Subjects(sub) ON DELETE CASCADE
) WITHOUT ROWID
`;

/** All schemas in creation order (NebulaAuth per-instance tables) */
export const ALL_SCHEMAS = [
  SUBJECTS_SCHEMA,
  SUBJECTS_IS_ADMIN_INDEX,
  MAGIC_LINKS_SCHEMA,
  MAGIC_LINKS_EMAIL_INDEX,
  INVITE_TOKENS_SCHEMA,
  INVITE_TOKENS_EMAIL_INDEX,
  REFRESH_TOKENS_SCHEMA,
  REFRESH_TOKENS_SUBJECT_INDEX,
  REFRESH_TOKENS_EXPIRES_INDEX,
  AUTHORIZED_ACTORS_SCHEMA,
];

// ---------------------------------------------------------------------------
// NebulaAuthRegistry schemas (singleton DO)
// ---------------------------------------------------------------------------

export const REGISTRY_INSTANCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS Instances (
  instanceName TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL
) WITHOUT ROWID
`;

export const REGISTRY_EMAILS_SCHEMA = `
CREATE TABLE IF NOT EXISTS Emails (
  email TEXT NOT NULL,
  instanceName TEXT NOT NULL,
  isAdmin INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (email, instanceName)
) WITHOUT ROWID
`;

export const REGISTRY_EMAILS_INSTANCE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_Emails_instanceName ON Emails(instanceName)
`;

/** All schemas for NebulaAuthRegistry */
export const REGISTRY_SCHEMAS = [
  REGISTRY_INSTANCES_SCHEMA,
  REGISTRY_EMAILS_SCHEMA,
  REGISTRY_EMAILS_INSTANCE_INDEX,
];

/**
 * The registry's schema as an ordered, append-only migration list, run by `@lumenize/sql-migrations`
 * in the `NebulaAuthRegistry` constructor (id-gated, atomic). One single statement per id:
 *   id-1..3 — the column-less baseline (today's {@link REGISTRY_SCHEMAS}, one statement per id), now
 *             FROZEN as baseline migrations;
 *   id-4    — add the nullable `improveProductConsent` column;
 *   id-5    — backfill consent=1 for existing **user** Universes (assume-true), excluding sub-instances
 *             (dotted names) and the reserved platform pseudo-Universe ({@link PLATFORM_INSTANCE_NAME}).
 *
 * **APPEND-ONLY:** never edit, reorder, or reuse an applied id — add a new id for any further change.
 * id-5's UPDATE references the column id-4 adds; this is safe ONLY because the runner applies the whole
 * pending set in one `transactionSync` (the ALTER is visible to the UPDATE) — never split them.
 * Backfill invariant: the only non-consentable single-segment row is `PLATFORM_INSTANCE_NAME`; if a
 * second reserved single-segment name is ever added, widen BOTH this `!= ?` and the corpus filter.
 */
export const REGISTRY_MIGRATIONS: SQLSchemaMigration[] = [
  { idMonotonicInc: 1, description: 'baseline: Instances table', sql: REGISTRY_INSTANCES_SCHEMA },
  { idMonotonicInc: 2, description: 'baseline: Emails table', sql: REGISTRY_EMAILS_SCHEMA },
  { idMonotonicInc: 3, description: 'baseline: Emails(instanceName) index', sql: REGISTRY_EMAILS_INSTANCE_INDEX },
  { idMonotonicInc: 4, description: 'add improveProductConsent column (nullable)', sql: 'ALTER TABLE Instances ADD COLUMN improveProductConsent INTEGER' },
  {
    idMonotonicInc: 5,
    description: 'backfill consent=1 for existing user Universes (assume-true)',
    sql: `UPDATE Instances SET improveProductConsent = 1 WHERE instanceName NOT LIKE '%.%' AND instanceName != ?`,
    params: [PLATFORM_INSTANCE_NAME],
  },
];
