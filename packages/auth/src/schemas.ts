/**
 * SQL schema definitions for Auth DO tables
 *
 * Written from scratch (no production data to migrate).
 * Created on first access via #ensureSchema().
 */

/**
 * Subjects table — authenticated entities (people, agents, services)
 */
export const SUBJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS subjects (
  sub TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  admin_approved INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  authorized_actors TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
)
`;

export const SUBJECTS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_subjects_email ON subjects(email)
`;

/**
 * Magic links table — pending one-time login tokens
 */
export const MAGIC_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)
`;

export const MAGIC_LINKS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email)
`;

/**
 * Invite tokens table — reusable admin-issued invite tokens
 */
export const INVITE_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS invite_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
`;

export const INVITE_TOKENS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_invite_tokens_email ON invite_tokens(email)
`;

/**
 * Refresh tokens table — active refresh tokens (stored by hash)
 */
export const REFRESH_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (subject_id) REFERENCES subjects(sub)
)
`;

export const REFRESH_TOKENS_SUBJECT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_subject ON refresh_tokens(subject_id)
`;

/**
 * All schemas in creation order
 */
export const ALL_SCHEMAS = [
  SUBJECTS_SCHEMA,
  SUBJECTS_EMAIL_INDEX,
  MAGIC_LINKS_SCHEMA,
  MAGIC_LINKS_EMAIL_INDEX,
  INVITE_TOKENS_SCHEMA,
  INVITE_TOKENS_EMAIL_INDEX,
  REFRESH_TOKENS_SCHEMA,
  REFRESH_TOKENS_SUBJECT_INDEX,
];
