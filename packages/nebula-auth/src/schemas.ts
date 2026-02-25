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

/** All schemas in creation order */
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
