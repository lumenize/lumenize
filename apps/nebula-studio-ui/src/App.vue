<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from "vue";
import { Send, RotateCw, Eraser, LogIn, Loader2, User, LogOut, Trash2, ChevronLeft, Plus, Hammer, Home, Mail } from "lucide-vue-next";
import DataUseNotice from "./DataUseNotice.vue";
import UniverseView from "./UniverseView.vue";
import { createNebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, deriveParticipants, startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay } from "@lumenize/nebula/frontend";
import type { TurnLiveness } from "@lumenize/nebula/frontend";
import type { ScopeDeletionPlan } from "@lumenize/nebula/frontend";
// Type-only (erased at build — does NOT pull cloudflare:workers into the browser bundle).
import type { Star } from "@lumenize/nebula";

// You build your hierarchy explicitly — claim a Universe, add a Galaxy, add a `.dev` Star, open it
// to author. No magic first-run, no `?scope=` sidestep (tasks/nebula-release-process.md § B2 + the
// hierarchy-builder sidebar). `authScope` = where you logged in (the refresh-cookie scope);
// `activeScope` = the scope you're working IN (a `.dev` Star under your authority). They differ once
// you "open" a Star: your Universe cookie mints a token whose admin pattern reaches the Star.
// The ACTIVE scope comes from the path, scope-first: `/{scope}` IS the URL — the scope is the first
// segment, and its tier (segment count) picks the view (universe manage-apps, galaxy Studio). The
// Worker-served prefixes (`/auth`, `/app`, `/gateway`) never reach this SPA — Workers Assets serves
// the SPA only for everything else — and universe slugs colliding with them are refused at claim
// (`RESERVED_UNIVERSE_SLUGS`), so a first segment that reaches here is a scope or nothing. There is
// deliberately NO `?scope=` fallback: a second way in is an interim that gets reached for later (the
// unlearning tax). The AUTH scope comes from the per-workspace localStorage hint
// `nebula.authScope:{activeScope}` — written by NebulaClient on every successful token acquisition,
// never the URL and never a cookie (the client must know it to hit the path-scoped refresh
// endpoint). Cold browser, no hint: pre-alpha the consumed link's scope IS the landing's active
// scope, so trying the active scope itself succeeds and writes the entry.
const pathScope = location.pathname.match(/^\/([^/?#]+)/)?.[1];
const urlScope = pathScope ? decodeURIComponent(pathScope) : undefined;
const AUTH_HINT_PREFIX = "nebula.authScope:";
const authHint = (active: string) => localStorage.getItem(AUTH_HINT_PREFIX + active) ?? undefined;
const activeScope = ref<string | undefined>(urlScope);
const authScope = ref<string | undefined>(urlScope ? (authHint(urlScope) ?? urlScope) : undefined);

// LOCAL notices only (login guidance, errors, nudges). The CONVERSATION renders from the
// durable Message subscription below — never from a local echo (D-echo: the sender sees
// its own message via the fanout, like everyone else).
type Msg = { role: "you" | "studio" | "error" | "thought"; text: string };
const messages = ref<Msg[]>([]);
const input = ref("");
const connected = ref(false);
const connecting = ref(false); // post-magic-link auto-connect in flight (shows "Signing you in…")
const busy = ref(false);

// ── The live thread (the durable `Message` subscription — the collapse's Phase 4) ──
// Membership rides the query subscription (ids only); content + meta auto-subscribe by
// READING `store.resources.Message[id]` in the render, and every participant's display
// name auto-subscribes by reading `store.lmz.profiles[profileId]` (refcounted; a name
// set later back-fills every earlier message).
const messageIds = ref<string[]>([]);
type ChatSub = { resourceIds: string[]; setRenderWindow(ids: string[]): void; onChange(cb: () => void): void; ready: Promise<void> } & Disposable;
let chatSub: ChatSub | null = null;
/** The in-flight transient stream (best-effort animation; the durable Message is truth). */
const streaming = ref<{ id: string; text: string } | null>(null);
/** The id of MY last posted message — "thinking" until an agent reply links back to it. */
const lastPostedId = ref<string | null>(null);
/** Liveness of MY in-flight turn (src/turn-liveness.ts): chunks are a hint, the durable
 *  reply is truth, `failed` means re-send by hand — nothing retries automatically. */
const turn = ref<TurnLiveness | null>(null);

function openChatThread(client: { resources: { subscribeQuery(q: unknown): unknown } }) {
  closeChatThread();
  const sub = client.resources.subscribeQuery({
    queryType: "parentChild", typeName: "Message", field: "chat", value: DEFAULT_CHAT_ID,
  }) as ChatSub;
  const sync = () => {
    messageIds.value = [...sub.resourceIds];
    sub.setRenderWindow(sub.resourceIds); // the pre-alpha thread is small — render it all
    // A durable message supersedes its transient stream.
    if (streaming.value && sub.resourceIds.includes(streaming.value.id)) streaming.value = null;
  };
  sub.onChange(sync);
  sub.ready.then(sync).catch(() => { /* denied/failed — the thread just stays empty */ });
  chatSub = sub;
}
function closeChatThread() {
  try { chatSub?.[Symbol.dispose](); } catch { /* already released */ }
  chatSub = null;
  messageIds.value = [];
  streaming.value = null;
  lastPostedId.value = null;
  turn.value = null;
}

type ThreadMsg = { id: string; kind: "agent" | "human"; mine: boolean; byline: string; content: string; thought?: string };
function participantName(p: { kind: "agent" | "human"; profileId?: string }): string {
  const prof = p.profileId ? (nebula.value?.store.lmz.profiles as Record<string, { value?: { name?: string; nickname?: string } }>)?.[p.profileId]?.value : undefined;
  return prof?.nickname || prof?.name || (p.kind === "agent" ? "Nebula" : "Someone");
}
const thread = computed<ThreadMsg[]>(() => {
  const store = nebula.value?.store;
  if (!store) return [];
  const mySub = (nebula.value?.client as { claims?: { sub?: string } } | undefined)?.claims?.sub;
  const out: ThreadMsg[] = [];
  for (const id of messageIds.value) {
    const snap = (store.resources as Record<string, Record<string, { value?: Record<string, unknown>; meta?: { actingToken?: never } }>>).Message?.[id];
    if (!snap?.value || !snap?.meta) continue; // content sub still loading
    const at = (snap.meta as { actingToken: Parameters<typeof deriveParticipants>[0] }).actingToken;
    const parties = deriveParticipants(at);
    out.push({
      id,
      kind: parties[0]!.kind,
      mine: at.sub === mySub && parties.length === 1,
      // The WHOLE-chain byline, top-down: "Nebula for {coach} for {user}" — every party
      // resolved via its own Profile (the read IS the subscription).
      byline: parties.map(participantName).join(" for "),
      content: String(snap.value.content ?? ""),
      thought: typeof snap.value.thought === "string" ? snap.value.thought : undefined,
    });
  }
  return out;
});
// ⚠️ **No profile-completion gate here, deliberately.** A nickname is collected ONCE, at the
// consent modal every arrival passes through (`ConsentModal.vue` / `canAccept`), so by the time
// anyone reaches a Studio or Universe surface they already have one. Re-introducing a blocking
// modal on this screen would interrupt a person mid-task to ask a question that was answered
// before they got here — and, when two dialogs were open at once, it made Save unclickable.
// A person who somehow arrives without a nickname degrades to `participantName`'s "Someone".

// The durable agent reply linking back to my last posted message — TRUTH (the
// transient stream is only a hint). Settles the liveness reducer, clearing any
// spurious `failed`, however late it lands (reconciliation).
const replyLanded = computed(() => {
  const posted = lastPostedId.value;
  if (!posted) return false;
  const store = nebula.value?.store;
  if (!store) return false;
  for (const id of messageIds.value) {
    const v = (store.resources as Record<string, Record<string, { value?: { replyTo?: string } }>>).Message?.[id]?.value;
    if (v?.replyTo === posted) return true;
  }
  return false;
});
watch(replyLanded, (landed) => {
  if (landed && turn.value) turn.value = settleTurn(turn.value);
});
// Thinking: my message posted, no agent reply linking back to it yet (the template
// shows the failed banner instead once the idle window lapses).
const thinking = computed(() => !!lastPostedId.value && !replyLanded.value);
// WHICH status bubble shows — derived, never template-order (see deriveTurnDisplay's
// JSDoc: a `failed` turn must outrank a frozen partial stream, which nothing clears).
const turnDisplay = computed(() => deriveTurnDisplay({
  streaming: !!streaming.value && !messageIds.value.includes(streaming.value.id),
  phase: turn.value?.phase,
  awaitingReply: thinking.value,
}));
// The idle ticker: a coarse sweep is all the reducer needs (the window is 90s), and
// a spurious `failed` self-heals on the durable reply.
let turnTicker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  turnTicker = setInterval(() => {
    if (turn.value) turn.value = evaluateTurn(turn.value, Date.now());
  }, 5_000);
});
onUnmounted(() => clearInterval(turnTicker));
const previewSrc = ref("");
const nebula = shallowRef<ReturnType<typeof createNebulaClient> | null>(null);

// login
const sessionExpired = ref(false); // a mid-session terminal auth failure flipped us back to login

// account / hierarchy
const menuOpen = ref(false);
const manageOpen = ref(false);
const accountEmail = ref<string | null>(null);
type Scope = { instanceName: string; tier: string; isDev: boolean; accepted?: boolean };
const scopes = ref<Scope[]>([]);
/** True once a scope load has COMPLETED. Distinct from `scopes.value.length === 0`, which is also
 *  true before the first load resolves — a difference UniverseView's empty state depends on. */
const scopesLoaded = ref(false);

/**
 * Flatten the person-scoped summary into the flat list this screen still renders.
 *
 * ⚠️ **A flat list cannot express a frontier.** The summary is budget-bounded and marks what it did
 * not descend into with `childCount`, so anything past the budget is absent here rather than merely
 * collapsed. That is acceptable for the two consumers below — a galaxy count and the manage tree of
 * a pre-alpha user, who is nowhere near the budget — and it is why the Home screen reads the NESTED
 * form instead. Anything that must be complete has to walk `children` and honour `childCount`.
 */
function flattenSummary(summary: { emails: { memberships: any[] }[] }): Scope[] {
  const out: Scope[] = [];
  const walk = (n: any) => {
    // ⚠️ `accepted` is carried, and its ABSENCE means something different from `false`. A membership
    // row states it; a descendant reached THROUGH one does not carry it at all, and is actionable
    // because the membership above it was accepted — that is what let the server return it.
    out.push({
      instanceName: n.scope, tier: n.tier, isDev: n.scope.endsWith('.dev'), accepted: n.accepted,
    } as Scope);
    (n.children ?? []).forEach(walk);
  };
  summary.emails.forEach((e) => e.memberships.forEach(walk));
  return out;
}
const addChildFor = ref<string | null>(null); // a Universe row whose "name a Galaxy" input is open
const addChildSlug = ref("");
// The SHARED wire type — never hand-copy it: this package has no `vue-tsc` and is the sole
// `SKIP_PACKAGES` entry, so a drifted copy reds in no gate and surfaces as a runtime TypeError.
const deleteTarget = ref<string | null>(null);
const deletePlan = ref<ScopeDeletionPlan | null>(null);

const log = (role: Msg["role"], text: string) => messages.value.push({ role, text });

// Post-collapse Studio's WORKING scope is the app-level GALAXY ({u}.{g}); the preview it embeds
// is per-STAR, composed as the galaxy + `.dev` — the one surface where the split is real.
const isWorkspace = (s?: string) => !!s && s.split(".").length === 2;
const previewStar = (s: string) => `${s}.dev`;
// Chat lives at the GALAXY ({u}.{g}) post-collapse — one thread shared across the galaxy's
// stars. A universe-only scope has no galaxy, so no chat pair is passed and the client's
// #chatHost() throws loudly if a chat call is attempted there.
const galaxyOf = (s?: string) => {
  const parts = (s ?? "").split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : undefined;
};
const chatPair = (s?: string) => {
  const g = galaxyOf(s);
  // Post-collapse Studio's DATA plane is the galaxy too: the thread subscription and its
  // per-message content reads ride `client.resources.*`, so the RESOURCE pair must point
  // at the GALAXY alongside the chat pair (the 'STAR' default stays for generated apps —
  // Studio is a specific consumer choosing its plane, the same shape every baseline
  // fixture and harness driver uses).
  return g ? { resourceHostBinding: "GALAXY", chatHostBinding: "GALAXY", chatScope: g } : {};
};
// Stage content: the hierarchy manager (opened from the avatar menu) > the live preview (inside a
// workspace) > the Universe page (connected at a one-segment account scope, where you create/see
// apps) > the help/welcome (the default, incl. the signed-out landing).
const stageMode = computed<"manage" | "preview" | "universe" | "help">(() =>
  manageOpen.value ? "manage"
    : !connected.value ? "help"
    : isWorkspace(activeScope.value) ? "preview"
    : "universe",
);

// A session worth a "Log out" affordance even before the WS connects (e.g. a stale cookie that
// failed to auto-connect, or a half-finished login) — so logout never vanishes when the avatar does.
const hasSession = computed(() => !!authScope.value);

function reloadPreview() {
  if (activeScope.value) previewSrc.value = `/app/${previewStar(activeScope.value)}/?t=${Date.now()}`;
}

// ── session ──────────────────────────────────────────────────────────────────
// ⚠️ **There is deliberately no login code here.** Signing in lives in the auth SPA at
// `/auth/login`, which serves every tier — a Tenant who never sees Studio needs the same front door,
// and a person with no session should not have to load Studio's whole bundle to find a form. Studio
// only ever ARRIVES authenticated; all that remains is where to send someone who is not.

/** The front door, and where a chosen Account/App/Tenant is picked. */
const AUTH_LOGIN = "/auth/login";
const homeFor = (s: string) => `/auth/${encodeURIComponent(s)}/home`;

function goToLogin() { window.location.assign(AUTH_LOGIN); }

/** Back to Home to pick a different Account, App or Tenant. */
function goHome() {
  menuOpen.value = false;
  window.location.assign(authScope.value ? homeFor(authScope.value) : AUTH_LOGIN);
}

/** A terminal auth failure (refresh token expired/invalid) on an ALREADY-connected tab — fired
 *  by the mesh client's onLoginRequired. A full reload re-runs connect() and falls back to the
 *  login form; an OPEN tab has no such path, so without this it stays stuck on a dead session
 *  ("warming up" forever). Mirror the reload: drop to the login view + tell the user why. */
function onSessionExpired() {
  connected.value = false;
  busy.value = false;
  connecting.value = false;
  sessionExpired.value = true;
}

async function connect() {
  if (!authScope.value) throw new Error("no scope to connect to");
  if (!activeScope.value) activeScope.value = authScope.value;
  const n = createNebulaClient({
    authScope: authScope.value,
    activeScope: activeScope.value,
    ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
    ...chatPair(activeScope.value),
    // The build reply lands here: the Galaxy answers whoever asked for the build, so
    // this one hook covers both the initial preview-ready cue and every rebuild. No
    // `onReload` — that gates the Star's parked publish channel, not this.
    onPreviewReady: (scope) => { if (scope === activeScope.value) reloadPreview(); },
    onLoginRequired: onSessionExpired,
  });
  await n.ready; // throws if not authenticated
  n.client.setOnStreamChunk((messageId, text, replyTo) => {
      // Render EVERY chunk — the thread is shared, so watching another participant's
      // reply appear is the product working. But only MY turn's chunks are liveness for
      // MY idle window: a message the single-flight latch skipped is never answered, and
      // re-arming it from someone else's running generation is a hang with no banner.
      streaming.value = { id: messageId, text };
      if (turn.value && replyTo === lastPostedId.value) {
        turn.value = signalTurn(turn.value, Date.now());
      }
    });
  nebula.value = n;
  connected.value = true;
  sessionExpired.value = false;
  if (isWorkspace(activeScope.value)) {
    previewSrc.value = `/app/${previewStar(activeScope.value!)}/`; // render now; refresh on the ready push
    n.client.warmPreview(); // initial-load refresh cue (builds push their own reload)
    openChatThread(n.client);
  }
  await nudgeNextStep();
}

/** After connecting, prepare the view for the scope the URL named.
 *
 *  ⚠️ **No auto-forward — the URL is the view (ADR-017).** `/{universe}` IS the Universe page:
 *  UniverseView renders the apps and the Create form, and *entering* an app is a URL navigation the
 *  person makes (a click → `enterScope` → new URL). An earlier version dropped a lone-galaxy account
 *  straight into that galaxy's Studio here, which meant `/{universe}` silently showed a galaxy — a
 *  view the address did not name. All this does now is load the app list for UniverseView; a
 *  workspace just confirms it is ready. */
async function nudgeNextStep() {
  // A workspace is ready to chat. The empty-thread hint lives in the template (shown only
  // while the conversation has no content), so there is nothing to log here.
  if (isWorkspace(activeScope.value)) return;
  await loadScopes(); // populate UniverseView's app list; an empty list opens the Create form
}

onMounted(() => {
  if (!authScope.value) return;
  connecting.value = true;
  connect()
    .catch(() => {
      // Auto-connect failed (not authenticated, or the scope was deleted/wiped). A failed
      // per-workspace hint is stale — drop it so the next load falls back to trying the
      // active scope itself (and, past pre-alpha, discovery). The URL scope is an explicit
      // navigation — keep showing the login form targeting it.
      if (urlScope) localStorage.removeItem(AUTH_HINT_PREFIX + urlScope);
    })
    .finally(() => {
      connecting.value = false;
    });
});

// Re-request the preview after a long absence. ⚠️ RE-DERIVED post-collapse: the original
// reason (waking an idle-slept dev container, which served a self-healing "waking" page) is
// GONE — the container is off the read path entirely and `dist` serves Galaxy-direct from
// the DO's VFS, so there is nothing to wake. The behavior survives on a DIFFERENT reason: a
// build that completes while this tab is hidden broadcasts a reload push the client may miss
// if its gateway WS dropped, so on return the preview can be a version behind. Gated on a
// long absence, since a quick tab-switch cannot have missed a build. The mesh client
// reconnects its own WS via backoff; this covers the preview the client doesn't own.
let hiddenAt = 0;
function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (awayMs > 4 * 60_000 && connected.value && isWorkspace(activeScope.value)) {
    reloadPreview();
  }
}
onMounted(() => document.addEventListener("visibilitychange", onVisibilityChange));
onUnmounted(() => document.removeEventListener("visibilitychange", onVisibilityChange));

async function send() {
  const msg = input.value.trim();
  if (!msg || !nebula.value || busy.value) return;
  // The composer only renders inside a workspace (a Universe shows UniverseView instead), so `send`
  // is always a chat submit — no Universe branch to guard.
  input.value = "";
  busy.value = true;
  try {
    // The COMMIT is the trigger (the collapse): postUserMessage writes the durable
    // Message; the Galaxy's commit hook starts the turn under MY authority; the reply
    // arrives on the Message subscription like everyone else's (no echo, no reply
    // channel). The preview reloads on the build-completion push, not here.
    lastPostedId.value = await nebula.value.client.postUserMessage(msg);
    turn.value = startTurn(Date.now());
  } catch (e) {
    log("error", `send failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function wipe() {
  if (!nebula.value || busy.value || !isWorkspace(activeScope.value)) return;
  busy.value = true;
  try {
    const client = nebula.value.client;
    // Fire-and-forget under the continuation-only model (no awaited callRaw). The wipe's
    // effect is reflected when the preview reloads; a dispatch failure is logged by the
    // framework (D6), so the confirmation log here is optimistic.
    client.lmz.call("STAR", previewStar(activeScope.value!), client.ctn<Star>().resetDevData());
    log("studio", "Wiped the development test data.");
    reloadPreview();
  } catch (e) {
    log("error", `wipe failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

// ── account + hierarchy ────────────────────────────────────────────────────────
// The client (NebulaClient.scopes) owns EVERY authed registry call — the JWT never leaves it, so
// there's no token plumbing in the view, a single auth authority, and no cookie-rotation race (the
// 2026-06-26 back-to-back-refresh hang). App code just calls methods and reacts.

async function loadScopes() {
  const client = nebula.value?.client;
  if (!client) return;
  accountEmail.value = (client.claims as { email?: string } | null)?.email ?? accountEmail.value;
  // Render order: parents before children, so the indent reads as a tree.
  scopes.value = flattenSummary(await client.scopes.summary())
    .sort((a, b) => a.instanceName.localeCompare(b.instanceName));
  scopesLoaded.value = true;
}

async function openManage() {
  menuOpen.value = false;
  manageOpen.value = true;
  deletePlan.value = null;
  deleteTarget.value = null;
  addChildFor.value = null;
  busy.value = true;
  try {
    await loadScopes();
  } catch (e) {
    log("error", `Could not load your account: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

function closeManage() {
  manageOpen.value = false;
  deletePlan.value = null;
  deleteTarget.value = null;
  addChildFor.value = null;
}

/** Indent depth for the tree (universe 0, galaxy/app 1 — `.dev` workspaces aren't tree rows). */
const depth = (s: Scope) => s.instanceName.split(".").length - 1;
/** Whether a galaxy's `.dev` development workspace exists yet (created with the app; `develop`
 *  lazily creates it for any app made before that). */
const hasDevStar = (galaxy: string) => scopes.value.some((s) => s.instanceName === `${galaxy}.dev`);
/** Tree rows = the hierarchy WITHOUT the `.dev` development workspaces — those aren't tenants and
 *  aren't shown as rows; you reach one via a galaxy's "Develop" button. */
const treeScopes = computed(() => scopes.value.filter((s) => !s.isDev));

/**
 * Whether this row's actions are live.
 *
 * ⚠️ **An unaccepted membership confers nothing** (ADR-012), so offering "+ App" or Delete on one is
 * an affordance for authority its holder has not taken up — it answers 403 and reads as a bug in the
 * product rather than as consent working. Found by driving the running app: a bootstrap address gets
 * an UNACCEPTED `nebula-platform` membership on any login, it sorts to the top of this list, and its
 * "+ App" button offered to create an app in the platform root.
 *
 * Only an explicit `false` disables — a descendant carries no flag and is reachable precisely
 * because the membership above it was accepted.
 */
const isActionable = (s: Scope) => s.accepted !== false;

/**
 * The reserved platform root — visible, never operated on from here.
 *
 * A platform admin holds dominion over everything, so "+ App" on this row would genuinely SUCCEED
 * and create an app inside the platform scope; Delete is refused server-side ("cannot be deleted")
 * but offering it at all reads as a product that will let you try. The row still renders, because
 * seeing it is the point — platform-level tools will live behind it eventually — it simply carries
 * no actions until there is something real to do there.
 */
const PLATFORM_ROOT = "nebula-platform";
const isReservedRoot = (s: Scope) => s.instanceName === PLATFORM_ROOT;

async function addGalaxy(universe: string) {
  const slug = addChildSlug.value.trim();
  if (!slug || busy.value) return;
  busy.value = true;
  try {
    await nebula.value!.client.scopes.createGalaxy(universe, slug); // its .dev workspace is born with it
    addChildFor.value = null;
    addChildSlug.value = "";
    await loadScopes();
  } catch (e) {
    log("error", `Could not add app: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

/** Enter a galaxy's Studio to author it. Ensures its private `.dev` workspace exists (created with
 *  the app, so this only fires for older apps that predate that), then NAVIGATES — a URL push, not
 *  an in-place client swap. A full reload at `/{galaxy}` rebuilds the client exactly as `connect()`
 *  does, so there is no second setup path to keep in sync, and the address always names the view
 *  (ADR-017). authScope/cookie unchanged; `enterScope` seeds the hint so the reload knows the
 *  universe cookie to spend. */
async function develop(galaxy: string) {
  if (busy.value) return;
  if (!hasDevStar(galaxy)) {
    busy.value = true;
    try {
      await nebula.value!.client.scopes.createDevWorkspace(galaxy);
    } catch (e) {
      log("error", `Could not start the development workspace: ${(e as Error).message}`);
      busy.value = false;
      return;
    }
    busy.value = false;
  }
  enterScope(galaxy);
}

/** Guided first-run ("B"): one app name → Galaxy + its `.dev` Star + open it, so a fresh user goes
 *  straight from their Universe to authoring without hunting through "Manage my scopes". The explicit
 *  per-row builder is still there for power users; this is the frictionless path. */
// ── The Universe page (UniverseView) — create an app, or open an existing one ──────────────────
const createError = ref<string | undefined>();

/** The apps under the account this page manages: galaxies directly beneath `activeScope`, never the
 *  hidden `.dev` workspaces. Empty for a fresh account, which is what makes the create modal open. */
const universeApps = computed(() =>
  scopes.value.filter(
    (s) => s.tier === "galaxy" && !s.isDev && s.instanceName.startsWith(`${activeScope.value}.`),
  ).map((s) => ({ scope: s.instanceName })),
);

/** Create the app, then NAVIGATE (not an in-place switch) to its Studio so the URL is the clean
 *  `/{u}.{g}` a person can share (ADR-017). A full reload for a brand-new app costs nothing —
 *  there is no chat or preview state to preserve — and lands App.vue straight in workspace mode. The
 *  scope to open comes from the server's returned `instanceName`, not the typed slug, so a URL can
 *  never disagree with what was created. */
/**
 * Seed the auth hint, then navigate to a scope's Studio.
 *
 * ⚠️ **The hint is what stops a "session expired" 401.** A galaxy's session lives at the UNIVERSE's
 * refresh cookie (`Path=/auth/{universe}`), and `/auth/{universe}.{galaxy}/refresh-token` does NOT
 * receive it — RFC-6265 path matching fails because the character after the `/auth/{universe}` prefix
 * is `.`, not `/`. So Studio must be told which cookie to spend: `authScope.value` (the universe this
 * page authenticated at). Home seeds this when IT navigates (`home-logic.ts` `authHintFor`); a
 * create/open from the Universe page has to do the same, because these NAVIGATE rather than switch in
 * place — a full reload drops the in-memory `authScope`, so only the stored hint survives.
 */
function enterScope(scope: string): void {
  try {
    if (authScope.value) localStorage.setItem(AUTH_HINT_PREFIX + scope, authScope.value);
  } catch { /* private mode — Studio falls back to trying the active scope, which 401s for a galaxy */ }
  window.location.assign(`/${scope}`);
}

async function onCreateApp(slug: string) {
  const universe = activeScope.value;
  if (!universe || busy.value) return;
  createError.value = undefined;
  busy.value = true;
  let created: string;
  try {
    ({ instanceName: created } = await nebula.value!.client.scopes.createGalaxy(universe, slug));
  } catch (e) {
    createError.value = (e as Error).message || "Could not create the app.";
    busy.value = false;
    return;
  }
  enterScope(created);
}

/** Open an existing app's Studio (the FLAVOUR-B list) — same clean-URL navigation, same hint. */
function onOpenApp(scope: string) {
  enterScope(scope);
}

async function openDeleteConfirm(target: string) {
  busy.value = true;
  try {
    deletePlan.value = await nebula.value!.client.scopes.deletePlan(target);
    deleteTarget.value = target;
  } catch (e) {
    log("error", `Could not plan delete: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

function cancelDelete() {
  deletePlan.value = null;
  deleteTarget.value = null;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  const plan = deletePlan.value;
  // Warn-don't-block (ADR-015): attached users never gate the delete — only a missing plan does.
  if (!target || !plan || busy.value) return;
  busy.value = true;
  try {
    const { affected } = await nebula.value!.client.scopes.delete(target);
    // Fan out the platform-DO teardown via mesh (the registry cleared its own rows already).
    const client = nebula.value?.client;
    if (client) {
      // Fire-and-forget teardown (continuation-only model): these were already
      // error-discarding (`.catch(() => {})`); a 3-arg call() drops the result and the
      // framework logs any dispatch failure (D6). The registry rows are already cleared.
      const ctnT = () => client.ctn<{ teardown(): Promise<void> }>().teardown();
      for (const a of affected) {
        const binding = a.tier === "universe" ? "UNIVERSE" : a.tier === "galaxy" ? "GALAXY" : "STAR";
        client.lmz.call(binding, a.instanceName, ctnT());
        // Post-collapse a `.dev` row needs no extra calls: the brain (chat + Workspace +
        // registry) lives on the GALAXY row's own teardown above, and DEV_STUDIO /
        // DEV_CONTAINER no longer exist. The dev star's data dies with its STAR teardown.
      }
    }
    cancelDelete();
    if (affected.some((a) => a.instanceName === authScope.value)) {
      resetToLoggedOut(); // deleted the scope we logged in at → clean first-run
    } else if (affected.some((a) => a.instanceName === activeScope.value)) {
      enterScope(authScope.value!); // deleted the app we're IN → navigate to the Universe page (URL push)
    } else {
      await loadScopes(); // deleted some other app while at the Universe page → just refresh the list
    }
  } catch (e) {
    log("error", `Delete failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

function resetToLoggedOut() {
  closeChatThread();
  if (activeScope.value) localStorage.removeItem(AUTH_HINT_PREFIX + activeScope.value);
  menuOpen.value = false;
  manageOpen.value = false;
  deletePlan.value = null;
  deleteTarget.value = null;
  connected.value = false;
  nebula.value = null;
  authScope.value = undefined;
  activeScope.value = undefined;
  previewSrc.value = "";
  messages.value = [];
  accountEmail.value = null;
  scopes.value = [];
}

/**
 * End every session this address holds, not just this one.
 *
 * ⚠️ **The symmetric twin of mint-all.** One click on a link minted a cookie per membership, so
 * "log out" meaning only THIS app would leave the others live — a genuine surprise on a shared
 * machine, where the plain reading of the words is "not still signed in over there". The server
 * expires each cookie at its own path; this side only has to stop using the session.
 */
async function logoutEverywhere() {
  menuOpen.value = false;
  const scope = authScope.value;
  try {
    if (scope) {
      await fetch(`/auth/${scope}/logout-all`, { method: "POST", credentials: "include" }).catch(() => {});
    }
  } finally {
    resetToLoggedOut();
    goToLogin();
  }
}

async function logout() {
  menuOpen.value = false;
  // Works whether or not the WS is up: connected → client.logout(); otherwise best-effort hit the
  // logout endpoint for the remembered scope (clears the HttpOnly cookie a stale session left behind).
  const client = nebula.value?.client as { logout?: () => Promise<void> } | undefined;
  const scope = authScope.value;
  try {
    if (client?.logout) await client.logout();
    else if (scope) await fetch(`/auth/${scope}/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  } catch {
    /* best-effort */
  }
  resetToLoggedOut();
}
</script>

<template>
  <div class="h-screen flex" data-theme="dark">
    <!-- Chat rail -->
    <!-- The chat rail shows for the signed-out landing and inside a workspace. A Universe has no
         chat — it renders UniverseView full-width in the stage — so the rail is hidden there. -->
    <section v-if="!connected || isWorkspace(activeScope)" class="w-[28rem] shrink-0 flex flex-col border-r border-base-300 bg-base-200">
      <header class="p-4 border-b border-base-300 flex items-center justify-between">
        <h1 class="text-lg font-bold">Nebula Studio</h1>
        <button
          v-if="isWorkspace(activeScope)"
          class="btn btn-sm btn-ghost"
          :disabled="busy || !connected"
          title="Wipe the development test data"
          @click="wipe"
        >
          <Eraser class="size-4" /> Wipe
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        <!-- The DURABLE thread (the Message subscription) — every participant, live,
             attributed by the whole-chain byline resolved through each party's Profile. -->
        <template v-for="m in thread" :key="m.id">
          <div :class="['chat', m.mine ? 'chat-end' : 'chat-start']">
            <div class="chat-header text-xs opacity-60 mb-0.5">{{ m.byline }}</div>
            <div :class="['chat-bubble', m.mine ? 'chat-bubble-primary' : '']">{{ m.content }}</div>
          </div>
          <details v-if="m.thought" class="text-xs opacity-70 -mt-1">
            <summary class="cursor-pointer select-none">💭 thought process</summary>
            <pre class="mt-2 whitespace-pre-wrap break-words bg-base-300 rounded p-2 max-h-80 overflow-auto">{{ m.thought }}</pre>
          </details>
        </template>
        <!-- Empty-thread hint — shown only while the conversation has no content. It is not a
             logged message, so the first turn that lands clears it for good (no stale bubble). -->
        <div v-if="connected && isWorkspace(activeScope) && thread.length === 0 && turnDisplay === 'none'"
             class="chat chat-start">
          <div class="chat-bubble">Connected. Describe the app you want to build.</div>
        </div>
        <!-- ONE status bubble, chosen by `turnDisplay` — the branches are keyed on the
             derived value, so precedence is the reducer's and not this list's order. -->
        <div v-if="turnDisplay === 'streaming'" class="chat chat-start">
          <div class="chat-header text-xs opacity-60 mb-0.5">Nebula</div>
          <div class="chat-bubble whitespace-pre-wrap">{{ streaming!.text }}</div>
        </div>
        <div v-else-if="turnDisplay === 'failed'" class="chat chat-start">
          <div class="chat-bubble chat-bubble-error text-sm">
            No reply arrived — this turn may have been lost. Re-send your message to try again.
          </div>
        </div>
        <div v-else-if="turnDisplay === 'thinking'" class="chat chat-start">
          <div class="chat-bubble flex items-center gap-2"><Loader2 class="size-4 animate-spin" /> Studio is thinking…</div>
        </div>
        <!-- Local notices (login guidance, nudges, errors) — never the conversation. -->
        <template v-for="(m, i) in messages" :key="'n' + i">
          <div :class="['chat', 'chat-start']">
            <div :class="['chat-bubble', m.role === 'error' ? 'chat-bubble-error' : '']">{{ m.text }}</div>
          </div>
        </template>
      </div>

      <footer class="p-4 border-t border-base-300">
        <!-- Unauthenticated: Studio has no login of its own — the auth SPA owns every front door. -->
        <div v-if="!connected" class="flex flex-col gap-2">
          <!-- Post-magic-link auto-connect in flight — don't flash a sign-in prompt. -->
          <div v-if="connecting" class="flex items-center gap-2 text-sm opacity-80 py-2">
            <Loader2 class="size-4 animate-spin" /> Signing you in…
          </div>
          <template v-else>
            <p v-if="sessionExpired" class="text-sm text-warning">
              Your session expired — please sign in again.
            </p>
            <button class="btn btn-primary" @click="goToLogin">
              <LogIn class="size-4" /> Sign in
            </button>
            <!-- Escape hatch with no avatar (stale cookie / half-finished sign-in). -->
            <button v-if="hasSession" type="button" class="btn btn-ghost btn-xs self-start opacity-70" @click="logout">
              <LogOut class="size-3.5" /> Log out
            </button>
          </template>
        </div>
        <!-- Authenticated: chat composer in a .dev Star, OR the guided "name your app" creator at a Universe. -->
        <form v-else class="flex gap-2 items-end" @submit.prevent="send">
          <!-- Wrapping composer: a textarea wraps long input instead of scrolling sideways.
               Enter sends; Shift+Enter inserts a newline. `field-sizing` auto-grows it. -->
          <textarea
            v-model="input"
            class="textarea textarea-bordered flex-1 resize-none max-h-40"
            rows="1"
            style="field-sizing: content"
            placeholder="Describe a change…"
            :disabled="busy"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button class="btn btn-primary" :disabled="busy || !input.trim()">
            <Loader2 v-if="busy" class="size-4 animate-spin" /><Send v-else class="size-4" />
          </button>
        </form>
      </footer>
    </section>

    <!-- Stage: account bar + help / hierarchy manager / preview -->
    <section class="flex-1 bg-base-100 flex flex-col min-w-0">
      <div v-if="connected" class="relative flex items-center justify-end gap-2 px-3 py-2 border-b border-base-300">
        <span v-if="busy" class="mr-auto flex items-center gap-1.5 text-xs opacity-70">
          <Loader2 class="size-3.5 animate-spin" /> Working…
        </span>
        <button
          v-if="isWorkspace(activeScope)"
          class="btn btn-sm btn-ghost btn-square"
          :disabled="busy"
          title="Reload preview"
          @click="reloadPreview"
        >
          <RotateCw class="size-4" />
        </button>
        <button class="btn btn-sm btn-ghost gap-2" title="Account" @click="menuOpen = !menuOpen">
          <span v-if="accountEmail" class="text-xs opacity-60">{{ accountEmail }}</span>
          <span class="inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-content"><User class="size-4" /></span>
        </button>
        <div v-if="menuOpen" class="absolute right-2 top-12 z-20 w-60 p-1 rounded-box border border-base-300 bg-base-200 shadow-lg flex flex-col">
          <button class="btn btn-sm btn-ghost justify-start" @click="goHome"><Home class="size-4" /> Home</button>
          <button class="btn btn-sm btn-ghost justify-start" @click="openManage">Manage my account</button>
          <a class="btn btn-sm btn-ghost justify-start" href="/auth/emails"><Mail class="size-4" /> Email addresses</a>
          <div class="divider my-0"></div>
          <!-- Two logouts, because they mean different things on a shared machine: one ends this
               app's session, the other ends every session this address holds anywhere. -->
          <button class="btn btn-sm btn-ghost justify-start" @click="logout"><LogOut class="size-4" /> Log out of this app</button>
          <button class="btn btn-sm btn-ghost justify-start text-error" @click="logoutEverywhere"><LogOut class="size-4" /> Log out everywhere</button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto">
        <!-- Help / intro (default + first use). -->
        <div v-if="stageMode === 'help'" class="p-8 max-w-2xl flex flex-col gap-5">
          <h2 class="text-xl font-bold">Welcome to Nebula</h2>
          <p class="opacity-80">You build inside a simple three-level hierarchy. You'll create it yourself, one level at a time.</p>
          <div class="flex flex-col gap-4">
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">🌌 Your account — that's you</p>
              <p class="text-sm opacity-80 mt-1">Your top-level space. If you have a company or a brand, that's probably the best name for it. If you're a solopreneur, you might use your own.</p>
            </div>
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">✨ An app</p>
              <p class="text-sm opacity-80 mt-1">Each app you build lives in your account. You can have as many as you like.</p>
            </div>
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">🧪 Development workspace — where you build</p>
              <p class="text-sm opacity-80 mt-1">While you build an app it has a private development workspace: you describe changes, see them live, and fill it with throwaway test data.</p>
            </div>
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">⭐ A tenant (later)</p>
              <p class="text-sm opacity-80 mt-1">When your app goes live, each of your end-customers gets their own isolated tenant — a private copy of the app with their own data. You don't create these by hand; they arrive via sign-up or invite.</p>
            </div>
          </div>
          <p class="opacity-80">Sign in on the left to get started.</p>
        </div>

        <!-- Hierarchy manager. -->
        <div v-else-if="stageMode === 'manage'" class="p-6 flex flex-col gap-4 max-w-2xl">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold">Manage my account</h2>
            <button class="btn btn-sm btn-ghost" @click="closeManage"><ChevronLeft class="size-4" /> Back</button>
          </div>
          <p v-if="accountEmail" class="text-sm opacity-70">Signed in as <span class="font-mono">{{ accountEmail }}</span></p>

          <!-- Destructive confirm. -->
          <div v-if="deletePlan" class="border border-error/60 rounded-box p-4 flex flex-col gap-3">
            <p class="font-medium">Delete <span class="font-mono">{{ deleteTarget }}</span>?</p>
            <p class="text-sm opacity-80">Permanently wipes (no undo):</p>
            <ul class="text-sm flex flex-col gap-1">
              <li v-for="a in deletePlan.affected" :key="a.instanceName">
                <span class="font-mono">{{ a.instanceName }}</span>
                <span class="opacity-50">({{ a.tier }}{{ a.isDev ? " · dev" : "" }})</span>
              </li>
            </ul>
            <p v-if="deletePlan.affectedUsers.total" class="text-sm text-warning">
              Warning — {{ deletePlan.affectedUsers.total }}
              other {{ deletePlan.affectedUsers.total === 1 ? "user" : "users" }} will lose access:
              {{ deletePlan.affectedUsers.sample.map((b) => `${b.instanceName} (${b.email})`).join(", ")
              }}{{ deletePlan.affectedUsers.total > deletePlan.affectedUsers.sample.length ? ", …" : "" }}.
            </p>
            <p v-else class="text-sm text-success">No other users — safe to wipe.</p>
            <div class="flex gap-2">
              <button class="btn btn-sm" :disabled="busy" @click="cancelDelete">Cancel</button>
              <button class="btn btn-sm btn-error" :disabled="busy" @click="confirmDelete">
                <Loader2 v-if="busy" class="size-4 animate-spin" /><Trash2 v-else class="size-4" /> Delete permanently
              </button>
            </div>
          </div>

          <!-- Hierarchy tree. -->
          <div v-else class="flex flex-col gap-2">
            <p v-if="busy && !scopes.length" class="text-sm opacity-60 flex items-center gap-2">
              <Loader2 class="size-4 animate-spin" /> Loading…
            </p>
            <p v-else-if="!scopes.length" class="text-sm opacity-60">Nothing here yet.</p>
            <template v-for="s in treeScopes" :key="s.instanceName">
              <div class="flex items-center gap-2 border border-base-300 rounded-box p-2.5" :style="{ marginLeft: depth(s) * 20 + 'px' }">
                <span class="font-mono text-sm flex-1 truncate">{{ s.instanceName }}</span>
                <span class="text-xs opacity-40">{{ s.tier === "galaxy" ? "app" : s.tier }}</span>

                <!-- Not yet taken up: no actions, and a pointer to where consent is given. -->
                <template v-if="!isActionable(s)">
                  <span class="badge badge-warning badge-sm">Not accepted</span>
                  <a class="btn btn-xs btn-ghost" :href="`/auth/${authScope}/home`">Review</a>
                </template>
                <!-- The reserved platform root: shown, not operated on. -->
                <template v-else-if="isReservedRoot(s)">
                  <span class="badge badge-ghost badge-sm">Platform</span>
                </template>
                <template v-else>
                  <button v-if="s.tier === 'galaxy'" class="btn btn-xs btn-primary" :disabled="busy" @click="develop(s.instanceName)" title="Open this app's private development workspace to build &amp; test it">
                    <Hammer class="size-3.5" /> Develop
                  </button>
                  <button v-else-if="s.tier === 'universe'" class="btn btn-xs btn-ghost" :disabled="busy" @click="addChildFor = addChildFor === s.instanceName ? null : s.instanceName">
                    <Plus class="size-3.5" /> App
                  </button>

                  <button class="btn btn-xs btn-ghost text-error" :disabled="busy" title="Delete" @click="openDeleteConfirm(s.instanceName)">
                    <Trash2 class="size-3.5" />
                  </button>
                </template>
              </div>
              <!-- inline "name a Galaxy" input under a Universe row -->
              <!-- The notice's SECOND placement: creating an app is a commit, so it renders here as
                   well as in the self-signup consent modal. One component, two renders. -->
              <form v-if="addChildFor === s.instanceName" class="flex flex-col gap-2" :style="{ marginLeft: (depth(s) + 1) * 20 + 'px' }" @submit.prevent="addGalaxy(s.instanceName)">
                <div class="flex gap-2 items-center">
                  <input v-model="addChildSlug" class="input input-bordered input-sm flex-1 font-mono" placeholder="name your app" :disabled="busy" />
                  <button class="btn btn-sm btn-primary" :disabled="busy || !addChildSlug.trim()">
                    <Loader2 v-if="busy" class="size-3.5 animate-spin" /> Add
                  </button>
                </div>
                <DataUseNotice />
              </form>
            </template>
          </div>
        </div>

        <!-- The Universe page: create an app, or open an existing one. -->
        <UniverseView
          v-else-if="stageMode === 'universe' && activeScope"
          :universe="activeScope"
          :apps="universeApps"
          :ready="scopesLoaded"
          :busy="busy"
          :error="createError"
          @create="onCreateApp"
          @open="onOpenApp"
        />

        <!-- Live preview. -->
        <iframe v-else :src="previewSrc" class="w-full h-full border-0" title="Preview" />
      </div>
    </section>
  </div>
</template>
