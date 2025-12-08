/**
 * SQL schema definitions for Auth DO tables
 * 
 * These schemas are created on first access via ensureSchema()
 */

/**
 * Users table - stores registered user accounts
 */
export const USERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
)
`;

/**
 * Index on email for fast lookups
 */
export const USERS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
`;

/**
 * Magic links table - stores pending magic link tokens
 */
export const MAGIC_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)
`;

/**
 * Index on email for rate limiting queries
 */
export const MAGIC_LINKS_EMAIL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email)
`;

/**
 * Refresh tokens table - stores active refresh tokens
 * Tokens are stored by hash for security
 */
export const REFRESH_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
`;

/**
 * Index on user_id for finding user's tokens
 */
export const REFRESH_TOKENS_USER_INDEX = `
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)
`;

/**
 * All schemas in order of creation
 */
export const ALL_SCHEMAS = [
  USERS_SCHEMA,
  USERS_EMAIL_INDEX,
  MAGIC_LINKS_SCHEMA,
  MAGIC_LINKS_EMAIL_INDEX,
  REFRESH_TOKENS_SCHEMA,
  REFRESH_TOKENS_USER_INDEX,
];

