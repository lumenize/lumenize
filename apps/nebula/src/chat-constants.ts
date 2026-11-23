/**
 * Chat-identity constants + the platform chat ontology SOURCE.
 *
 * Kept **client-safe**, with no import at all, so BOTH Studio's page (which reaches it through the `./client` entry and hands
 * {@link CHAT_MESSAGE_ONTOLOGY_VERSION} to its client for every chat op) and the server can
 * use them WITHOUT dragging server code into the browser bundle. The COMPILE of {@link CHAT_MESSAGE_TYPES} lives in `./chat-ontology` (it
 * reaches the parser-validator → `cloudflare:workers`); only the pure strings live here.
 */

/**
 * The fixed, well-known Chat id for pre-alpha's single chat thread. Client and server
 * agree on it as a **constant** — a fresh or late-joining client subscribes
 * `Message where chat == DEFAULT_CHAT_ID` with NO discovery lookup. Multi-chat (many
 * ids + a list/discovery surface) is deferred with the management UI. A fixed
 * v4-shaped UUID so it round-trips the same id validation as any client-supplied
 * resource id.
 */
export const DEFAULT_CHAT_ID = '00000000-0000-4000-8000-000000000001';

/** One snapshot of a `Message`, named by its whole key: a later edit to the message does not
 *  change which version this names. A turn's calls name the person's message they acted for so. */
export interface MessageSnapshot { id: string; validFrom: string }

/**
 * The DAG node the whole conversation hangs from: a node of its own beneath the Galaxy's root, at a
 * fixed id as the root's is, so a grant on it covers the chat and nothing a later node beside it
 * holds. Its children are {@link MESSAGES_NODE_ID}, where the thread lives, and
 * {@link ROUNDS_NODE_ID}, where each turn's rounds live. A grant here reaches both, so it is where
 * whoever sees the chat gets `read`, and where the agent holds its `write`.
 *
 * Nobody's request creates these nodes. The Galaxy creates the three in its own `onStart`, as its
 * system principal, through the call a page makes, and only where one is absent, so a node an
 * admin has renamed or moved stays as they left it. The agent holds no membership, so its `write`
 * here is its only way to read the thread, post and store its rounds (ADR-025). An admin can
 * revoke it, and the Galaxy writes it back at its next start or at the next post.
 */
export const CHAT_NODE_ID = '00000000-0000-4000-8000-000000000004';

/**
 * The DAG node every chat `Message` and `ServedBuild` lives under, a child of {@link CHAT_NODE_ID},
 * at a fixed id. A grant here is a person's place in the conversation: `read`, `write` to post, and
 * `admin` to invite and manage. `write` here is the chat floor ({@link requireChatFloor} in
 * `galaxy.ts`), which is also what reading and writing source and starting a build take.
 */
export const MESSAGES_NODE_ID = '00000000-0000-4000-8000-000000000002';

/**
 * The DAG node a turn's rounds live under, beside {@link MESSAGES_NODE_ID} beneath
 * {@link CHAT_NODE_ID}, at a fixed id. Nobody's grant at `messages` reaches it, so a round here is
 * written by the agent, whose `write` at `chat` covers it, by an app admin through dominion, or by
 * someone an admin granted `write` at `chat` or here. Nothing ties the `Round` type to this node,
 * so a member can write a `Round` at `messages`; a turn reads only the rounds here, which is what
 * keeps such a `Round` out of it.
 */
export const ROUNDS_NODE_ID = '00000000-0000-4000-8000-000000000003';

/**
 * What an invite to the conversation gives a collaborator: `write` at `messages`, to post, and
 * `read` at `chat`, to read each turn's rounds as well as the thread. One invite names both, so a
 * revoke at `messages` ends the posting and leaves the reading, which a revoke at `chat` ends.
 */
export const COLLABORATOR_GRANTS: Array<{ nodeId: string; tier: 'read' | 'write' }> = [
  { nodeId: MESSAGES_NODE_ID, tier: 'write' },
  { nodeId: CHAT_NODE_ID, tier: 'read' },
];

/**
 * The platform chat ontology's version LABEL — the value a chat client sends on every
 * data op (the `ontologyVersion` the Galaxy host ENFORCES; a mismatch answers
 * `OntologyStaleError`). It changes on an ontology change, never a code build. The
 * platform's chat ontology lives in this (platform) repo and installs as one seeded
 * version — the same one-file-one-version convention the user app's ontology follows
 * in its Workspace repo. The chat loader's bundle id derives from it, so a changed seed
 * row MUST come with a new label (`scripts/gen-validator-seeds.ts`).
 */
export const CHAT_MESSAGE_ONTOLOGY_VERSION = 'chat-message-v7';

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
 * `codegen` is the turn's summary. Its calls are on its rounds (`Round`, below), each naming the
 * snapshot of the person's message it acted for and the wire form of the claims it ran under: `sub`, `act` and `profileId`,
 * never `access` or `aud`, which stay off anything a client is sent (ADR-016).
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
 * `Round` is one round of a turn, a Resource of its own at {@link ROUNDS_NODE_ID}, where the turn
 * reads it, written by the agent as itself: the model's text and reasoning, each tool call as the provider returned it
 * (`raw`, kept whole, so the arguments are stored once and parsed when read), and each call's
 * result or error with `messageSnapshot`, the person's message it acted for named by its whole key
 * `{ id, validFrom }`, and the claims it ran under, all four absent until the call has run. The
 * turn copies the snapshot and its claims when it takes the message up, so a call answered after
 * an edit to that message still names the version it ran under. `message` names the agent `Message` the turn will commit, which need not exist
 * yet (ADR-006: an id, never looked up). `closing` marks the closing step's round: each post it was
 * shown, with the `validFrom` it read.
 *
 * `Message.chat`, `ServedBuild.chat` and `Round.message` each declare an index: every Studio
 * subscribes to the first two by their chat, a Galaxy's Messages are the largest type it holds,
 * and a message's rounds are read by its id.
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
    };
    answers?: Message[];
  }`,
  `interface Round {
    chat: Chat;
    /** @index */
    message: Message;
    index: number;
    text: string;
    reasoning?: string;
    calls: Array<{
      raw: unknown;
      messageSnapshot?: { id: string; validFrom: string };
      claims?: { sub: string; profileId?: string; act?: unknown };
      result?: unknown;
      error?: string;
    }>;
    closing?: Array<{ id: string; validFrom: string }>;
  }`,
].join('\n');
