/**
 * Chat-identity constants + the platform chat ontology SOURCE.
 *
 * Kept in a **client-safe LEAF** — it imports ONLY `./dag-ops` (itself a pure
 * constants/types leaf) — so BOTH the browser client (`nebula-client.ts`, bundled via
 * the `./client` entry, which must send {@link CHAT_MESSAGE_ONTOLOGY_VERSION} on every
 * chat op) and the server can use them WITHOUT dragging server code into the browser
 * bundle. The COMPILE of {@link CHAT_MESSAGE_TYPES} lives in `./chat-ontology` (it
 * reaches the parser-validator → `cloudflare:workers`); only the pure strings live here.
 */
import { ROOT_NODE_ID } from './dag-ops';

/**
 * The fixed, well-known Chat id for pre-alpha's single chat thread. Client and server
 * agree on it as a **constant** — a fresh or late-joining client subscribes
 * `Message where chat == DEFAULT_CHAT_ID` with NO discovery lookup. Multi-chat (many
 * ids + a list/discovery surface) is deferred with the management UI. A fixed
 * v4-shaped UUID so it round-trips the same id validation as any client-supplied
 * resource id.
 */
export const DEFAULT_CHAT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The single DAG node every chat `Message` lives under — MAPS to `ROOT_NODE_ID`: the
 * Galaxy's orgTree is ONE node (chat is the whole of the Galaxy's resource plane, so
 * there is no other subtree for a grant on the root to cascade into), and the three
 * tiers on that single node (`read` · `write` = post · `admin` = invite/manage) are
 * the whole permission model. Map rather than collapse: the constant stays, so a
 * later second node is a one-value change instead of every call site.
 */
export const CHAT_NODE_ID = ROOT_NODE_ID;

/**
 * The platform chat ontology's version LABEL — the value a chat client sends on every
 * data op (the `ontologyVersion` the Galaxy host ENFORCES; a mismatch answers
 * `OntologyStaleError`). It changes on an ontology change, never a code build. The
 * platform's chat ontology lives in this (platform) repo and installs as one seeded
 * version — the same one-file-one-version convention the user app's ontology follows
 * in its Workspace repo.
 */
export const CHAT_MESSAGE_ONTOLOGY_VERSION = 'chat-message-v1';

/**
 * The Chat/Message ontology, in source (ADR-001 — TS types ARE the schema).
 * `Message.chat: Chat` and `Message.replyTo?: Message` are to-one relationships
 * (write shape: by-id `string`s). `status` ∈ {`thinking`,`streaming`,`complete`,
 * `failed`} (kept as `string` — the enum lives in the writing code, not a second
 * schema language). ⚠️ NO `role` and NO `author` — display derives ONLY from the
 * server-stamped `meta.actingToken` (author from `sub`, `kind` from the outermost
 * `act?.sub === NEBULA_SUB`), which is what makes author spoofing impossible; a
 * client-written identity field would be a second, forgeable source of truth.
 *
 * `replyTo` is REQUIRED on an agent message (the corpus needs prompt→reply linkage —
 * the folded-shape pin) but optional in the TYPE because a human message has none;
 * `commitAgentMessage`'s signature is what enforces the agent half.
 *
 * `codegen` is the folded codegen corpus (replaces the deleted `Turns` side table),
 * ABSENT on a human message. ⚠️ It is an INLINE type literal, deliberately: the
 * ontology compiler treats ANY named interface in this text as an ontology type and
 * rewrites fields typed as one to a by-id `string` (ADR-006), so a named
 * `CodegenRecord` interface would flatten to a ref with nothing to reference — an
 * inline literal is the compiler's one value-object vehicle. (Named non-resource
 * value objects are a parser-validator feature gap — tracked as package feedback.)
 */
export const CHAT_MESSAGE_TYPES = [
  'interface Chat { title: string }',
  `interface Message {
    chat: Chat;
    content: string;
    status?: string;
    thought?: string;
    replyTo?: Message;
    codegen?: {
      model: string;
      scaffold?: string;
      sourceCommit?: string;
      rounds: number;
      stop: string;
      appliedPaths: string[];
      gate?: { ok: boolean; errorTail?: string };
      toolCalls: Array<{ name: string; args?: unknown; result?: unknown; error?: string }>;
    };
  }`,
].join('\n');
