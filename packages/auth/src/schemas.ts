/**
 * SQL schema definitions for Auth DO tables
 *
 * Written from scratch (no production data to migrate).
 * Created on first access via #ensureSchema().
 *
 * Naming convention: PascalCase table names, camelCase column names.
 */

/**
 * Subjects table — authenticated entities (people, agents, services)
 */
export const SUBJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS Subjects (
  sub TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  adminApproved INTEGER NOT NULL DEFAULT 0,
  isAdmin INTEGER NOT NULL DEFAULT 0,
  authorizedActors TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  lastLoginAt INTEGER
)
`;

export const SUBJECTS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_Subjects_email ON Subjects(email)
`;

/**
 * Filtered index for admin lookups — only contains admin rows, stays very small.
 * Used by admin notification queries (SELECT email FROM Subjects WHERE isAdmin = 1).
 */
export const SUBJECTS_IS_ADMIN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_Subjects_isAdmin ON Subjects(sub) WHERE isAdmin = 1
`;

/**
 * Magic links table — pending one-time login tokens
 */
export const MAGIC_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS MagicLinks (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)
`;

export const MAGIC_LINKS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_MagicLinks_email ON MagicLinks(email)
`;

/**
 * Invite tokens table — reusable admin-issued invite tokens
 */
export const INVITE_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS InviteTokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
)
`;

export const INVITE_TOKENS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_InviteTokens_email ON InviteTokens(email)
`;

/**
 * Refresh tokens table — active refresh tokens (stored by hash)
 * ON DELETE CASCADE: when a subject is deleted, their refresh tokens are automatically removed.
 */
export const REFRESH_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS RefreshTokens (
  tokenHash TEXT PRIMARY KEY,
  subjectId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (subjectId) REFERENCES Subjects(sub) ON DELETE CASCADE
)
`;

export const REFRESH_TOKENS_SUBJECT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_RefreshTokens_subjectId ON RefreshTokens(subjectId)
`;

/**
 * Index on expiresAt for efficient expired token cleanup sweeps.
 */
export const REFRESH_TOKENS_EXPIRES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_RefreshTokens_expiresAt ON RefreshTokens(expiresAt)
`;

/**
 * All schemas in creation order
 */
export const ALL_SCHEMAS = [
  SUBJECTS_SCHEMA,
  SUBJECTS_EMAIL_INDEX,
  SUBJECTS_IS_ADMIN_INDEX,
  MAGIC_LINKS_SCHEMA,
  MAGIC_LINKS_EMAIL_INDEX,
  INVITE_TOKENS_SCHEMA,
  INVITE_TOKENS_EMAIL_INDEX,
  REFRESH_TOKENS_SCHEMA,
  REFRESH_TOKENS_SUBJECT_INDEX,
  REFRESH_TOKENS_EXPIRES_INDEX,
];
