/**
 * Chat-identity constants + the platform chat ontology SOURCE.
 *
 * Kept **client-safe** — its one import is `ROOT_NODE_ID` from `@lumenize/resources/client` —
 * so BOTH Studio's page (which reaches it through the `./client` entry and hands
 * {@link CHAT_MESSAGE_ONTOLOGY_VERSION} to its client for every chat op) and the server can
 * use them WITHOUT dragging server code into the browser bundle. The COMPILE of {@link CHAT_MESSAGE_TYPES} lives in `./chat-ontology` (it
 * reaches the parser-validator → `cloudflare:workers`); only the pure strings live here.
 */
import { ROOT_NODE_ID, type TreeSeed } from '@lumenize/resources/client';
import { NEBULA_SUB } from '@lumenize/mesh/client';

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
 * The DAG node every chat `Message` lives under: a node of its own beneath the Galaxy's root, at a
 * fixed id as the root's is, so a grant on it covers the conversation and nothing a later node
 * beside it holds. Its three tiers are the chat's whole permission model: `read`, `write` to post,
 * and `admin` to invite and manage. The Galaxy's seed creates it ({@link GALAXY_TREE_SEED}).
 */
export const CHAT_NODE_ID = '00000000-0000-4000-8000-000000000002';

/**
 * What the Galaxy declares in its tree: the `chat` node, and the agent's `write` on it. These are
 * the two rows nobody's request creates. The owner reaches the tree through dominion and a
 * collaborator gets a grant by invite, while the agent holds no membership, so a grant in this tree
 * is its only way to read the thread and post (ADR-025). The grant is protected: with it revoked
 * the agent could not hear the request to restore it.
 */
export const GALAXY_TREE_SEED: TreeSeed = {
  nodes: [{ nodeId: CHAT_NODE_ID, parentNodeId: ROOT_NODE_ID, slug: 'chat', label: 'Chat' }],
  grants: [{ nodeId: CHAT_NODE_ID, sub: NEBULA_SUB, tier: 'write', protected: true }],
};

/**
 * The platform chat ontology's version LABEL — the value a chat client sends on every
 * data op (the `ontologyVersion` the Galaxy host ENFORCES; a mismatch answers
 * `OntologyStaleError`). It changes on an ontology change, never a code build. The
 * platform's chat ontology lives in this (platform) repo and installs as one seeded
 * version — the same one-file-one-version convention the user app's ontology follows
 * in its Workspace repo. The chat loader's bundle id derives from it, so a changed seed
 * row MUST come with a new label (`scripts/gen-validator-seeds.ts`).
 */
export const CHAT_MESSAGE_ONTOLOGY_VERSION = 'chat-message-v4';

/**
 * The Chat/Message ontology, in source (ADR-001 — TS types ARE the schema).
 * `Message.chat: Chat` and `Message.replyTo?: Message` are to-one relationships
 * (write shape: by-id `string`s). `status` ∈ {`thinking`,`streaming`,`complete`,
 * `failed`} (kept as `string` — the enum lives in the writing code, not a second
 * schema language). ⚠️ NO `role` and NO `author` — display derives ONLY from the
 * server-stamped `meta.recordedClaims` (author from `sub`, and `kind` from whether that
 * subject is the agent), which is what makes author spoofing impossible; a
 * client-written identity field would be a second, forgeable source of truth.
 *
 * `replyTo` is the post an agent message's turn took up (the corpus needs prompt→reply
 * linkage — the folded-shape pin), and `answers` is every post the message answers, `replyTo`
 * among them: a post is answered when an agent message names it there, so one message can
 * answer several people. Both are optional in the TYPE, since a person's post has neither and
 * an agent's outcome post, which belongs to no turn, has neither; `agentMessageValue` is the
 * one builder, and keeps the two consistent.
 *
 * `codegen` is the folded codegen corpus (replaces the deleted `Turns` side table),
 * ABSENT on a human message. ⚠️ It is an INLINE type literal, deliberately: the
 * ontology compiler treats ANY named interface in this text as an ontology type and
 * rewrites fields typed as one to a by-id `string` (ADR-006), so a named
 * `CodegenRecord` interface would flatten to a ref with nothing to reference — an
 * inline literal is the compiler's one value-object vehicle. (Named non-resource
 * value objects are a parser-validator feature gap — tracked as package feedback.)
 *
 * Each `toolCalls` entry can name the post it acted for and the wire form of the claims it ran
 * under: `sub`, `act` and `profileId`, never `access` or `aud`, which stay off anything a
 * client is sent (ADR-016).
 *
 * `codegen.build` replaced the per-write `gate` when the compilers left the Worker
 * (tasks/archive/nebula-move-compilers-out-of-the-worker.md): a write does no work at all now,
 * and the container `build` reports instead — `checked` is what tsc actually looked
 * at (a checked file absent from `findings` is KNOWN CLEAN), `findings` are raw
 * diagnostic lines carrying file/line themselves.
 *
 * `ServedBuild` records each build a Star's host starts serving (ADR-024's build version):
 * a landing creates one at a fresh id, `{ chat, star: 'dev', buildVersion }`, and Studio
 * subscribes to `ServedBuild where chat == DEFAULT_CHAT_ID`, so every Studio on the app
 * hears every landing. `star` names the Star slug whose host serves it.
 *
 * `Message.chat` and `ServedBuild.chat` each declare an index, since every Studio subscribes to
 * both by their chat and a Galaxy's Messages are the largest type it holds.
 *
 * A change here bumps {@link CHAT_MESSAGE_ONTOLOGY_VERSION}, never an in-place edit. An
 * already-seeded Galaxy then installs the new row the first time a client pinned to it asks,
 * since the plane installs its source's row on a mismatch (`Resources`' version rule), and it
 * tells each client on the old version to reload once. The 2026-08-29 in-place edit predates
 * that install, when a bump would have failed every client with no way to re-seed.
 */
export const CHAT_MESSAGE_TYPES = [
  'interface Chat { title: string }',
  `interface ServedBuild {
    /** @index */
    chat: Chat;
    star: string; buildVersion: string }`,
  `interface Message {
    /** @index */
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
      build?: { checked: string[]; findings: string[] };
      toolCalls: Array<{
        name: string; args?: unknown; result?: unknown; error?: string;
        post?: string;
        claims?: { sub: string; profileId?: string; act?: unknown };
      }>;
    };
    answers?: Message[];
  }`,
].join('\n');
