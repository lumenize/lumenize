/**
 * Session-identity constants for the Studio chat (Child 3, D-session).
 *
 * Kept in a **client-safe LEAF** — it imports ONLY `./dag-ops` (itself a pure
 * constants/types leaf) — so BOTH the browser client (`nebula-client.ts`, bundled via
 * the `./client` entry) and the server can use them WITHOUT dragging server code into
 * the browser bundle. They deliberately do NOT live in `devstudio-resource-ontology.ts`,
 * which imports `./galaxy` + the parser-validator (reaches `cloudflare:workers`); a
 * browser import of that module would break the bundle, and pool-workers would mask it
 * (see packaging.md § cross-platform `cloudflare:workers`).
 */
import { ROOT_NODE_ID } from './dag-ops';

/**
 * The fixed, well-known Session id for pre-alpha's single chat session (D-session).
 * Client and server agree on it as a **constant** — a fresh or late-joining client
 * subscribes `Message where session == DEFAULT_SESSION_ID` with NO discovery lookup.
 * Multi-session (many ids + a session-list/discovery surface) is deferred with the
 * management UI. A fixed v4-shaped UUID so it round-trips the same id validation
 * as any client-supplied resource id.
 */
export const DEFAULT_SESSION_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The single DAG node every Message of a session lives under (D5, pre-alpha).
 * `ROOT_NODE_ID` for now — the session's permission scope; multi-node-per-session is a
 * non-goal. `targetsForQuery(sessionQuery, SESSION_NODE_ID)`'s single-node recheck
 * (Stage-2 M1) is provably correct under this pin.
 */
export const SESSION_NODE_ID = ROOT_NODE_ID;
