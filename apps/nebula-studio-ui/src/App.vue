<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted } from "vue";
import { Send, RotateCw, Eraser, LogIn, Loader2, User, LogOut, Trash2, ChevronLeft, Plus, Hammer } from "lucide-vue-next";
import { createNebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, deriveParticipants } from "@lumenize/nebula/frontend";
import type { ScopeDeletionPlan } from "@lumenize/nebula/frontend";
// Type-only (erased at build — does NOT pull cloudflare:workers into the browser bundle).
import type { Star } from "@lumenize/nebula";

// You build your hierarchy explicitly — claim a Universe, add a Galaxy, add a `.dev` Star, open it
// to author. No magic first-run, no `?scope=` sidestep (tasks/nebula-release-process.md § B2 + the
// hierarchy-builder sidebar). `authScope` = where you logged in (the refresh-cookie scope);
// `activeScope` = the scope you're working IN (a `.dev` Star under your authority). They differ once
// you "open" a Star: your Universe cookie mints a token whose admin pattern reaches the Star.
// The ACTIVE scope comes from the path: `/studio/{scope}` — the canonical, and ONLY, form the
// magic link redirects to (the first URL segment names a SURFACE; the second is the scope).
// There is deliberately NO `?scope=` fallback: a second way in is an interim that gets reached
// for later (the unlearning tax). The AUTH scope comes from the per-workspace localStorage hint
// `nebula.authScope:{activeScope}` — written by NebulaClient on every successful token
// acquisition, never the URL and never a cookie (the client must know it to hit the path-scoped
// refresh endpoint). Cold browser, no hint: pre-alpha the consumed link's scope IS the landing's
// active scope, so trying the active scope itself succeeds and writes the entry.
const pathScope = location.pathname.match(/^\/studio\/([^/?#]+)/)?.[1];
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
// Thinking: my message posted, no agent reply linking back to it yet.
const thinking = computed(() => {
  const posted = lastPostedId.value;
  if (!posted) return false;
  const store = nebula.value?.store;
  if (!store) return false;
  for (const id of messageIds.value) {
    const v = (store.resources as Record<string, Record<string, { value?: { replyTo?: string } }>>).Message?.[id]?.value;
    if (v?.replyTo === posted) return false;
  }
  return true;
});
const previewSrc = ref("");
const nebula = shallowRef<ReturnType<typeof createNebulaClient> | null>(null);

// login
const email = ref("");
const sentTo = ref<string | null>(null);
const needsClaim = ref(false);
const sessionExpired = ref(false); // a mid-session terminal auth failure flipped us back to login
const claimSlug = ref("");

// account / hierarchy
const menuOpen = ref(false);
const manageOpen = ref(false);
const accountEmail = ref<string | null>(null);
type Scope = { instanceName: string; tier: string; isDev: boolean };
const scopes = ref<Scope[]>([]);
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
// Stage content: the hierarchy manager (opened from the avatar menu) > the live preview (only when
// you're inside a `.dev` Star) > the Universe/Galaxy/Star help (the default, incl. first use).
const stageMode = computed<"manage" | "preview" | "help">(() =>
  manageOpen.value ? "manage" : connected.value && isWorkspace(activeScope.value) ? "preview" : "help",
);

// A session worth a "Log out" affordance even before the WS connects (e.g. a stale cookie that
// failed to auto-connect, or a half-finished login) — so logout never vanishes when the avatar does.
const hasSession = computed(() => !!authScope.value);

function reloadPreview() {
  if (activeScope.value) previewSrc.value = `/app/${previewStar(activeScope.value)}/?t=${Date.now()}`;
}

// ── Universe-slug suggestion ─────────────────────────────────────────────────
// Company domain → the domain (john@acme.com → acme-com); a common/shared personal domain → the
// local part (cassidy.perkins@lumenize.com → cassidy-perkins). Sanitized to a valid slug.
const COMMON_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "live.com",
  "msn.com", "proton.me", "protonmail.com", "me.com",
  "maccherone.com", "lumenize.com", // alpha-user shared domains → treat like personal
]);
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
}
function suggestUniverseSlug(emailAddr: string): string {
  const [local, domain] = emailAddr.toLowerCase().split("@");
  if (!domain) return slugify(local ?? "");
  return COMMON_DOMAINS.has(domain) ? slugify(local ?? "") : slugify(domain);
}

// ── login ────────────────────────────────────────────────────────────────────
// `discover` returns `universeGalaxyStarId` per scope (renamed from `instanceName` when identity
// moved to the registry-minted surrogate `sub` — tasks/nebula-auth-surrogate-sub.md; `sub`-free).
async function discover(emailAddr: string): Promise<{ universeGalaxyStarId: string; isAdmin: boolean }[]> {
  const res = await fetch(`/auth/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailAddr }),
  });
  if (!res.ok) throw new Error(`discover ${res.status}: ${await res.text().catch(() => "")}`);
  return (await res.json()) as { universeGalaxyStarId: string; isAdmin: boolean }[];
}

function rememberAuthScope(s: string) {
  authScope.value = s;
  activeScope.value = s;
  // No localStorage write here — NebulaClient writes the per-workspace hint on every
  // successful token acquisition (the authoritative, self-healing moment).
}

async function sendMagicLink() {
  const e = email.value.trim();
  if (!e || busy.value) return;
  busy.value = true;
  try {
    let target = urlScope; // an explicit `/studio/{scope}` (the post-login redirect / ui-smoke) bypasses discovery
    if (!target) {
      const entries = await discover(e);
      if (entries.length === 1) {
        target = entries[0]!.universeGalaxyStarId;
      } else if (entries.length === 0) {
        claimSlug.value = suggestUniverseSlug(e); // prefill the suggestion
        needsClaim.value = true;
        return;
      } else {
        log("error", `${entries.length} workspaces for ${e} — the picker is a later feature. Open the per-workspace link for now.`);
        return;
      }
    }
    rememberAuthScope(target);
    const res = await fetch(`/auth/${target}/email-magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: e }),
    });
    if (!res.ok) throw new Error(`magic-link ${res.status}: ${await res.text().catch(() => "")}`);
    sentTo.value = e;
  } catch (err) {
    log("error", `Login failed: ${(err as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function claimUniverse() {
  const slug = claimSlug.value.trim();
  const e = email.value.trim();
  if (!slug || !e || busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(`/auth/claim-universe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ slug, email: e }),
    });
    if (!res.ok) throw new Error(`claim ${res.status}: ${await res.text().catch(() => "")}`);
    rememberAuthScope(slug);
    needsClaim.value = false;
    sentTo.value = e;
  } catch (err) {
    log("error", `Claim failed: ${(err as Error).message}`);
  } finally {
    busy.value = false;
  }
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
    onPreviewReady: (scope) => { if (scope === activeScope.value) reloadPreview(); },
    onLoginRequired: onSessionExpired,
  });
  await n.ready; // throws if not authenticated
  n.client.setOnStreamChunk((messageId, text) => { streaming.value = { id: messageId, text }; });
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

/** Route a returning builder from the SERVER tree (not local state — the magic link opens a fresh
 *  tab). Already in a `.dev` workspace → ready to author. Otherwise, by app count: none → nudge to
 *  create the first (chat composer = "name your app", "B"); exactly one → drop them straight into
 *  developing it; several → open the scopes manager to choose. */
async function nudgeNextStep() {
  if (isWorkspace(activeScope.value)) {
    log("studio", "Connected. Describe the app you want to build.");
    return;
  }
  let galaxies: Scope[] = [];
  try {
    const list = await nebula.value!.client.scopes.list();
    scopes.value = list.sort((a, b) => a.instanceName.localeCompare(b.instanceName));
    galaxies = list.filter((s) => s.tier === "galaxy");
  } catch {
    log("studio", "Welcome! Type a name for your first app below to get started.");
    return;
  }
  if (galaxies.length === 0) {
    log("studio", "Welcome! Let’s create your first app — type a name for it below and I’ll set it up for you.");
  } else if (galaxies.length === 1) {
    await develop(galaxies[0]!.instanceName); // one app → straight into building it
  } else {
    await openManage(); // several apps → choose in the scopes manager
    log("studio", "Welcome back. Pick an app to develop, or type a name in the chat to create a new one.");
  }
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

// When the tab is backgrounded long enough for the dev container to idle-sleep (~5m), re-request the
// preview on return so it wakes — the DevContainer serves a self-healing "waking" page until it's back
// up. Gated on a long absence so quick tab-switches (container still warm) don't reload needlessly. The
// mesh client reconnects its own gateway WS via its backoff; this covers the preview the client doesn't own.
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
  if (!isWorkspace(activeScope.value)) {
    // At a Universe — the composer creates an app (guided first-run "B") instead of chatting.
    input.value = "";
    await createApp(msg);
    return;
  }
  input.value = "";
  busy.value = true;
  try {
    // The COMMIT is the trigger (the collapse's Phase 4): postUserMessage writes the
    // durable Message; the Galaxy's commit hook starts the turn under MY authority; the
    // reply arrives on the Message subscription like everyone else's (no echo, no reply
    // channel). The preview reloads on the build-completion push, not here.
    lastPostedId.value = await nebula.value.client.postUserMessage(msg);
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
  scopes.value = (await client.scopes.list()).sort((a, b) => a.instanceName.localeCompare(b.instanceName));
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
    log("error", `Could not load scopes: ${(e as Error).message}`);
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

async function addGalaxy(universe: string) {
  const slug = addChildSlug.value.trim();
  if (!slug || busy.value) return;
  busy.value = true;
  try {
    await nebula.value!.client.scopes.createGalaxy(universe, slug);
    await nebula.value!.client.scopes.createDevWorkspace(`${universe}.${slug}`); // its dev workspace, implicit
    addChildFor.value = null;
    addChildSlug.value = "";
    await loadScopes();
  } catch (e) {
    log("error", `Could not add app: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

/** Open a galaxy's private `.dev` development workspace to author it: switch the working scope +
 *  reconnect (authScope/cookie unchanged; our admin token reaches it). The workspace is created with
 *  the app (lazily here for older apps); it is never shown or deleted from the tree — only wiped. */
async function develop(galaxy: string) {
  if (busy.value) return;
  if (!hasDevStar(galaxy)) {
    busy.value = true;
    try {
      await nebula.value!.client.scopes.createDevWorkspace(galaxy);
      await loadScopes();
    } catch (e) {
      log("error", `Could not start the development workspace: ${(e as Error).message}`);
      busy.value = false;
      return;
    }
    busy.value = false;
  }
  await openWorkspace(galaxy);
}

/** Enter an app's workspace to author it: the working scope becomes the GALAXY ({u}.{g} — chat,
 *  scopes, warmPreview all ride it), and the embedded preview is its `.dev` Star. authScope/cookie
 *  unchanged; our admin token reaches it. */
async function openWorkspace(galaxy: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    try {
      await (nebula.value?.client as { disconnect?: () => unknown } | undefined)?.disconnect?.();
    } catch {
      /* old WS best-effort */
    }
    activeScope.value = galaxy;
    const n = createNebulaClient({
      authScope: authScope.value!,
      activeScope: galaxy,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...chatPair(galaxy),
      onPreviewReady: (scope) => { if (scope === activeScope.value) reloadPreview(); },
      onLoginRequired: onSessionExpired,
    });
    await n.ready;
    n.client.setOnStreamChunk((messageId, text) => { streaming.value = { id: messageId, text }; });
    nebula.value = n;
    messages.value = [];
    manageOpen.value = false;
    openChatThread(n.client);
    previewSrc.value = `/app/${previewStar(galaxy)}/`; // render the stage NOW (Galaxy-served dist)
    // The ready signal is immediate post-collapse (nothing to warm for viewing — the container is
    // only engaged on a build); it survives a WS reconnect (addressed by instanceName). Build
    // completions push their own reload; the manual Reload button stays as the fallback.
    n.client.warmPreview();
  } catch (e) {
    log("error", `Could not open ${galaxy}: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

/** Guided first-run ("B"): one app name → Galaxy + its `.dev` Star + open it, so a fresh user goes
 *  straight from their Universe to authoring without hunting through "Manage my scopes". The explicit
 *  per-row builder is still there for power users; this is the frictionless path. */
async function createApp(name: string) {
  const universe = authScope.value;
  const slug = slugify(name);
  if (!slug || !universe || busy.value) return;
  busy.value = true;
  try {
    await nebula.value!.client.scopes.createGalaxy(universe, slug);
    await nebula.value!.client.scopes.createDevWorkspace(`${universe}.${slug}`);
  } catch (e) {
    log("error", `Could not create app: ${(e as Error).message}`);
    busy.value = false;
    return;
  }
  busy.value = false;
  await openWorkspace(`${universe}.${slug}`); // reconnects + clears chat + manages its own busy
  log("studio", `Your app “${slug}” is ready. Now describe what you want to build.`);
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
    } else {
      if (affected.some((a) => a.instanceName === activeScope.value)) activeScope.value = authScope.value;
      await loadScopes();
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
  sentTo.value = null;
  needsClaim.value = false;
  accountEmail.value = null;
  scopes.value = [];
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
    <section class="w-[28rem] shrink-0 flex flex-col border-r border-base-300 bg-base-200">
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
        <!-- The transient stream (best-effort animation; superseded by the durable reply). -->
        <div v-if="streaming && !messageIds.includes(streaming.id)" class="chat chat-start">
          <div class="chat-header text-xs opacity-60 mb-0.5">Nebula</div>
          <div class="chat-bubble whitespace-pre-wrap">{{ streaming.text }}</div>
        </div>
        <div v-else-if="thinking" class="chat chat-start">
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
        <!-- Unauthenticated: email magic-link login (+ a first-run Universe claim). -->
        <div v-if="!connected" class="flex flex-col gap-2">
          <!-- Post-magic-link auto-connect in flight — don't flash the login form. -->
          <div v-if="connecting" class="flex items-center gap-2 text-sm opacity-80 py-2">
            <Loader2 class="size-4 animate-spin" /> Signing you in…
          </div>
          <template v-else>
            <p v-if="sessionExpired && !sentTo" class="text-sm text-warning">
              Your session expired — please sign in again.
            </p>
            <p v-if="sentTo" class="text-sm opacity-80">
              Magic link sent to <span class="font-mono">{{ sentTo }}</span> — check your email to finish signing in.
            </p>
            <template v-else>
              <form v-if="!needsClaim" class="flex flex-col gap-2" @submit.prevent="sendMagicLink">
                <input v-model="email" type="email" class="input input-bordered" placeholder="you@example.com" :disabled="busy" />
                <button class="btn btn-primary" :disabled="busy || !email.trim()">
                  <Loader2 v-if="busy" class="size-4 animate-spin" /><LogIn v-else class="size-4" /> Send magic link
                </button>
              </form>
              <form v-else class="flex flex-col gap-2" @submit.prevent="claimUniverse">
                <p class="text-sm opacity-80">Name your <span class="font-medium">Universe</span> (see the guide on the right):</p>
                <input v-model="claimSlug" class="input input-bordered font-mono" placeholder="your-universe-slug" :disabled="busy" />
                <button class="btn btn-primary" :disabled="busy || !claimSlug.trim()">
                  <Loader2 v-if="busy" class="size-4 animate-spin" /><LogIn v-else class="size-4" /> Claim &amp; send magic link
                </button>
              </form>
            </template>
            <!-- Logout escape hatch even with no avatar (stale cookie / half-finished login). -->
            <button v-if="hasSession" type="button" class="btn btn-ghost btn-xs self-start opacity-70" @click="logout">
              <LogOut class="size-3.5" /> Log out
            </button>
          </template>
        </div>
        <!-- Authenticated: chat composer in a .dev Star, OR the guided "name your app" creator at a Universe. -->
        <form v-else class="flex gap-2" @submit.prevent="send">
          <input
            v-model="input"
            class="input input-bordered flex-1"
            :placeholder="isWorkspace(activeScope) ? 'Describe a change…' : 'Name your app to create it…'"
            :disabled="busy"
          />
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
        <div v-if="menuOpen" class="absolute right-2 top-12 z-20 w-52 p-1 rounded-box border border-base-300 bg-base-200 shadow-lg flex flex-col">
          <button class="btn btn-sm btn-ghost justify-start" @click="openManage">Manage my scopes</button>
          <button class="btn btn-sm btn-ghost justify-start" @click="logout"><LogOut class="size-4" /> Log out</button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto">
        <!-- Help / intro (default + first use). -->
        <div v-if="stageMode === 'help'" class="p-8 max-w-2xl flex flex-col gap-5">
          <h2 class="text-xl font-bold">Welcome to Nebula</h2>
          <p class="opacity-80">You build inside a simple three-level hierarchy. You'll create it yourself, one level at a time.</p>
          <div class="flex flex-col gap-4">
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">🌌 Universe — that's you</p>
              <p class="text-sm opacity-80 mt-1">Your top-level space. If you have a company or a brand, that's probably the best choice for your Universe slug. If you're a solopreneur, you might use your name.</p>
            </div>
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">✨ Galaxy — an app</p>
              <p class="text-sm opacity-80 mt-1">Each app you build is a Galaxy in your Universe. You can have as many as you like.</p>
            </div>
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">🧪 Development workspace — where you build</p>
              <p class="text-sm opacity-80 mt-1">While you build an app it has a private development workspace: you describe changes, see them live, and fill it with throwaway test data.</p>
            </div>
            <div class="border border-base-300 rounded-box p-4">
              <p class="font-medium">⭐ Star — a tenant (later)</p>
              <p class="text-sm opacity-80 mt-1">When your app goes live, each of your end-customers gets their own isolated Star — their private copy of the app with their own data. You don't create these by hand; they arrive via sign-up or invite.</p>
            </div>
          </div>
          <p v-if="!connected" class="opacity-80">Claim your Universe on the left to get started.</p>
          <p v-else class="opacity-80">Next: just type a name for your app in the chat on the left and I'll set it up — or open <span class="font-medium">Manage my scopes</span> (top right) to build it by hand.</p>
        </div>

        <!-- Hierarchy manager. -->
        <div v-else-if="stageMode === 'manage'" class="p-6 flex flex-col gap-4 max-w-2xl">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold">Manage my scopes</h2>
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
              <Loader2 class="size-4 animate-spin" /> Loading your scopes…
            </p>
            <p v-else-if="!scopes.length" class="text-sm opacity-60">No scopes yet.</p>
            <template v-for="s in treeScopes" :key="s.instanceName">
              <div class="flex items-center gap-2 border border-base-300 rounded-box p-2.5" :style="{ marginLeft: depth(s) * 20 + 'px' }">
                <span class="font-mono text-sm flex-1 truncate">{{ s.instanceName }}</span>
                <span class="text-xs opacity-40">{{ s.tier === "galaxy" ? "app" : s.tier }}</span>

                <button v-if="s.tier === 'galaxy'" class="btn btn-xs btn-primary" :disabled="busy" @click="develop(s.instanceName)" title="Open this app's private development workspace to build &amp; test it">
                  <Hammer class="size-3.5" /> Develop
                </button>
                <button v-else-if="s.tier === 'universe'" class="btn btn-xs btn-ghost" :disabled="busy" @click="addChildFor = addChildFor === s.instanceName ? null : s.instanceName">
                  <Plus class="size-3.5" /> Galaxy
                </button>

                <button class="btn btn-xs btn-ghost text-error" :disabled="busy" title="Delete" @click="openDeleteConfirm(s.instanceName)">
                  <Trash2 class="size-3.5" />
                </button>
              </div>
              <!-- inline "name a Galaxy" input under a Universe row -->
              <form v-if="addChildFor === s.instanceName" class="flex gap-2 items-center" :style="{ marginLeft: (depth(s) + 1) * 20 + 'px' }" @submit.prevent="addGalaxy(s.instanceName)">
                <input v-model="addChildSlug" class="input input-bordered input-sm flex-1 font-mono" placeholder="galaxy-slug (your app)" :disabled="busy" />
                <button class="btn btn-sm btn-primary" :disabled="busy || !addChildSlug.trim()">
                  <Loader2 v-if="busy" class="size-3.5 animate-spin" /> Add
                </button>
              </form>
            </template>
          </div>
        </div>

        <!-- Live preview. -->
        <iframe v-else :src="previewSrc" class="w-full h-full border-0" title="Preview" />
      </div>
    </section>
  </div>
</template>
