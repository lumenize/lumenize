<script setup lang="ts">
import { viewState, navigate, leaveTo, pageScope, scopeUrl, platformUrl } from "./view-state";
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { Send, RotateCw, Eraser, Loader2, User, UserRound, LogOut, Home, Mail, Settings } from "lucide-vue-next";
import UniverseView from "./UniverseView.vue";
import AppSettings from "./AppSettings.vue";
import ConfirmDelete from "./ConfirmDelete.vue";
import HostWait from "./HostWait.vue";
import { needsFreshLogin } from "./auth/home-logic";
import { createNebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, deriveParticipants, startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay } from "@lumenize/nebula/frontend";
import type { TurnLiveness } from "@lumenize/nebula/frontend";
// Type-only (erased at build — does NOT pull cloudflare:workers into the browser bundle).
import type { Star } from "@lumenize/nebula";

// The scope this Studio works in is its HOST's: `crm.acme.lumenize.dev` is the galaxy `acme.crm`,
// and `acme.lumenize.dev` the universe `acme`, whose page lists its apps (ADR-021). Its tier picks
// the view. The client names no scope: its token comes from the platform host's refresh, which reads
// this page's host from `Origin` and answers with that host's scope as the token's `aud`.
const activeScope = pageScope;

// ── The URL, through src/view-state.ts only: `viewState` reads it, `navigate` / `leaveTo` write it ──
const overlay = computed(() => viewState.value.overlay);

// LOCAL notices only (login guidance, errors, nudges). The CONVERSATION renders from the
// durable Message subscription below — never from a local echo (D-echo: the sender sees
// its own message via the fanout, like everyone else).
type Msg = { role: "you" | "studio" | "error" | "thought"; text: string };
const messages = ref<Msg[]>([]);
const input = ref("");
const connected = ref(false);
const connecting = ref(false); // post-magic-link auto-connect in flight (shows "Signing you in…")
const busy = ref(false);

// ── The live thread (the durable `Message` subscription) ──
// Membership rides the query subscription (ids only); content + meta auto-subscribe by
// READING `store.resources.Message[id]` in the render, and every participant's display
// name auto-subscribes by reading `store.lmz.profiles[profileId]` (refcounted; a name
// set later back-fills every earlier message).
const messageIds = ref<string[]>([]);
type ChatSub = { resourceIds: string[]; setRenderWindow(ids: string[]): void; onChange(cb: () => void): void; ready: Promise<void> } & Disposable;
let chatSub: ChatSub | null = null;
/** The in-flight transient stream (best-effort animation; the durable Message is truth). */
const streaming = ref<{ id: string; text: string } | null>(null);
// ── The live transcript: a compact strip by default, the full text on request ──
// Token streaming is an unreadable scroll at speed, so the thread shows only a pulse and the tail
// of the latest text; clicking opens a modal with everything so far. The transcript survives the
// stream's end while the modal is open — a reader mid-page is not interrupted by the durable
// message landing — and is dropped on close.
/** Open when the URL names a message's transcript; the text shown is the stream held for it. */
const streamModalOpen = computed(() => overlay.value.transcript !== undefined);
const streamTranscript = ref("");
watch(() => streaming.value?.text, (text) => { if (text !== undefined) streamTranscript.value = text; });
const streamTail = computed(() => {
  const t = streaming.value?.text ?? "";
  const tail = t.length > 80 ? `…${t.slice(-80)}` : t;
  return tail.replace(/\s+/g, " ");
});
const transcriptEl = ref<HTMLPreElement | null>(null);
watch(streamTranscript, async () => {
  if (!streamModalOpen.value) return;
  await nextTick();
  transcriptEl.value?.scrollTo({ top: transcriptEl.value.scrollHeight });
});
function openStreamModal() {
  if (streaming.value) navigate({ transcript: streaming.value.id });
}
function closeStreamModal() {
  navigate({ transcript: undefined });
  if (!streaming.value) streamTranscript.value = "";
}
/** The URL names a message whose stream this page never held (a shared link after the fact). */
const transcriptMissing = computed(() =>
  overlay.value.transcript !== undefined && streaming.value?.id !== overlay.value.transcript && !streamTranscript.value);
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

/** One face on the avatar stack: the display name (its hover is the full name), the picture if
 *  there is one, and the kind — a fallback initial stands in for a missing picture. */
type Party = { name: string; title?: string; picture?: string; kind: "agent" | "human" };
type ThreadMsg = {
  id: string; kind: "agent" | "human"; mine: boolean; byline: string; title?: string;
  /** Front-to-back. An act-bearing message stacks the ACTOR in front of the SUBJECT — the agent on top,
   *  the person it ran for behind, offset just enough to stay hoverable. A plain message is one face. */
  stack: Party[];
  content: string; thought?: string;
};
/** What a hover reveals: the full name, when the person set one and it is not what the byline
 *  already shows. A `title` rather than a hover-only widget, so assistive tech and keyboards get
 *  it too — hover alone is invisible to both. */
function participantTitle(p: { kind: "agent" | "human"; profileId?: string }): string | undefined {
  const prof = p.profileId ? (nebula.value?.store.lmz.profiles as Record<string, { value?: { name?: string; nickname?: string } }>)?.[p.profileId]?.value : undefined;
  return prof?.name && prof.name !== participantName(p) ? prof.name : undefined;
}
function participantPicture(p: { kind: "agent" | "human"; profileId?: string }): string | undefined {
  const prof = p.profileId ? (nebula.value?.store.lmz.profiles as Record<string, { value?: { picture?: string } }>)?.[p.profileId]?.value : undefined;
  return prof?.picture || undefined;
}
function participantName(p: { kind: "agent" | "human"; profileId?: string }): string {
  const prof = p.profileId ? (nebula.value?.store.lmz.profiles as Record<string, { value?: { name?: string; nickname?: string } }>)?.[p.profileId]?.value : undefined;
  return prof?.nickname || prof?.name || (p.kind === "agent" ? "Lumenize" : "Someone");
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
      // The WHOLE-chain byline, top-down: "Lumenize for {coach} for {user}" — every party
      // resolved via its own Profile (the read IS the subscription).
      byline: parties.map(participantName).join(" for "),
      // The full names behind the byline, in the same order — shown on hover.
      title: parties.map(participantTitle).filter(Boolean).join(" for ") || undefined,
      stack: (parties.length > 1 ? [parties[0]!, parties[parties.length - 1]!] : [parties[0]!]).map((p) => ({
        name: participantName(p), title: participantTitle(p), picture: participantPicture(p), kind: p.kind,
      })),
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

// ── Visible motion while the turn is silent ──
// The model is called whole-response, so nothing CAN arrive from it for tens of seconds at a time
// and the spinner is all a person has. An elapsed counter is truthful motion at 1 Hz, driven
// locally from when the turn was posted — no server involvement, and no pretence of progress.
// (Real cadence is token streaming, parked with the model-lane decision in backlog.md.)
const turnStartedAt = ref<number | null>(null);
const nowTick = ref(Date.now());
let elapsedTicker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  elapsedTicker = setInterval(() => { if (turn.value) nowTick.value = Date.now(); }, 1_000);
});
onUnmounted(() => clearInterval(elapsedTicker));
const elapsedSec = computed(() =>
  turnStartedAt.value === null ? 0 : Math.max(0, Math.floor((nowTick.value - turnStartedAt.value) / 1000)),
);
const previewSrc = ref("");
const nebula = shallowRef<ReturnType<typeof createNebulaClient> | null>(null);

// account / hierarchy
const menuOpen = ref(false);

// ── My profile — the ONE place to change how I appear, reached from the avatar menu ──
// The nickname is first collected at the consent modal every arrival passes through; this is where
// it (and an optional full name) can be changed afterwards.
const profileOpen = computed(() => overlay.value.profile && connected.value);
const profileNickname = ref("");
const profileFullName = ref("");
const profileSaving = ref(false);
/** The picture chosen in the editor this session: uploaded the moment it is picked (so the
 *  preview is the real served object), written into the Profile on Save with the names. */
const profilePicture = ref<string | undefined>();
const pictureUploading = ref(false);

const log = (role: Msg["role"], text: string) => messages.value.push({ role, text });

// Post-collapse Studio's WORKING scope is the app-level GALAXY ({u}.{g}); the preview it embeds
// is per-STAR, composed as the galaxy + `.dev` — the one surface where the split is real.
const isWorkspace = (s?: string) => !!s && s.split(".").length === 2;

/** MY live public profile — the same slot every byline reads, so a save here re-renders them all. */
const myProfile = computed<{ name?: string; nickname?: string; picture?: string } | undefined>(() => {
  const pid = (nebula.value?.client as { claims?: { profileId?: string } } | undefined)?.claims?.profileId;
  if (!pid) return undefined;
  return (nebula.value?.store.lmz.profiles as
    Record<string, { value?: { name?: string; nickname?: string; picture?: string } }> | undefined)?.[pid]?.value;
});

/** Seed the form from the live snapshot each time it opens — never from stale local refs. */
function openProfile() {
  menuOpen.value = false;
  navigate({ profile: true });
}
function closeProfile() { navigate({ profile: false }); }
// Seeded from the live profile while the editor is open and UNTOUCHED — whichever lands last, the
// opening or the profile. Arriving by URL opens the editor the moment the socket connects, before
// the profile subscription has delivered, so seeding once on open would seed from nothing; the
// button path never saw that because the profile had long arrived.
const profileDirty = ref(false);
watch([profileOpen, myProfile], ([open, mine]) => {
  if (!open) { profileDirty.value = false; return; }
  if (profileDirty.value) return;
  profileNickname.value = mine?.nickname ?? "";
  profileFullName.value = mine?.name ?? "";
  profilePicture.value = mine?.picture;
}, { immediate: true });

const canSaveProfile = computed(() => profileNickname.value.trim().length > 0 && !profileSaving.value);

async function saveProfile() {
  if (!canSaveProfile.value) return;
  profileSaving.value = true;
  try {
    const name = profileFullName.value.trim();
    // ⚠️ `writeProfile` REPLACES the whole public set — an omitted field is written as NULL, not
    // left alone — so the picture always rides: the one just uploaded, else the one on file.
    const picture = profilePicture.value ?? myProfile.value?.picture;
    await nebula.value!.client.updateMyProfile({
      nickname: profileNickname.value.trim(),
      ...(name ? { name } : {}),
      ...(picture ? { picture } : {}),
    });
    closeProfile();
  } catch (e) {
    log("error", `Could not save your profile: ${(e as Error).message}`);
  } finally {
    profileSaving.value = false;
  }
}

/** Shrink to an avatar before upload — the server caps bytes, but a phone photo is 10× that and
 *  nobody needs it at full size next to a chat bubble. Falls back to the original if decoding
 *  fails (an odd container the browser cannot draw); the server still sniffs and bounds it. */
async function downscaleImage(file: File, max = 512): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 256 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the picture"))), "image/png"));
  } catch {
    return file;
  }
}

async function onPictureChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // so picking the same file again still fires `change`
  if (!file || !nebula.value) return;
  pictureUploading.value = true;
  try {
    profilePicture.value = await nebula.value.client.uploadProfilePicture(await downscaleImage(file));
  } catch (err) {
    log("error", `Could not upload that picture: ${(err as Error).message}`);
  } finally {
    pictureUploading.value = false;
  }
}
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
// Stage content: the live preview (inside a workspace) > the Universe page (a one-segment account
// scope, where you create and open apps). Until the client connects the stage says it is signing in;
// with no session at all the client sends this page to log in and brings it back.
const stageMode = computed<"preview" | "universe" | "connecting">(() =>
  !connected.value ? "connecting"
    : isWorkspace(activeScope) ? "preview"
    : "universe",
);

/** The dev Star's own host — the as-you dev tab this Studio frames, and the only page it frames. */
const devTabUrl = (galaxy: string) => scopeUrl(previewStar(galaxy));
const devTabOrigin = activeScope && isWorkspace(activeScope) ? new URL(devTabUrl(activeScope)).origin : undefined;

function reloadPreview() {
  if (activeScope && isWorkspace(activeScope)) previewSrc.value = `${devTabUrl(activeScope)}?t=${Date.now()}`;
}

// ── session ──────────────────────────────────────────────────────────────────
// ⚠️ **There is deliberately no login code here.** Signing in lives on the platform host, which
// serves every tier — a Tenant who never sees Studio needs the same front door. Studio only ever
// ARRIVES authenticated: with no session, the client sends this page to log in, naming it in
// `return_to`, and the login brings the person back.

/** Back to Home to pick a different Account, App or Tenant. */
function goHome() {
  menuOpen.value = false;
  leaveTo(platformUrl("/"));
}

/**
 * What the dev tab inside this Studio says about its session. The frame's client posts when it has
 * no token for the dev Star, or when someone logs out inside it; either way Studio's own session is
 * untouched, and the stage says so. ⚠️ Only a message from the frame this page created, at the
 * origin it framed, is read — any other page could post the same shape.
 */
const previewNotice = ref<string | undefined>();
const previewFrame = ref<HTMLIFrameElement | null>(null);
function onFrameMessage(e: MessageEvent) {
  if (!devTabOrigin || e.origin !== devTabOrigin || e.source !== previewFrame.value?.contentWindow) return;
  const type = (e.data as { type?: unknown } | null)?.type;
  if (type === "lumenize:login-required") previewNotice.value = "The preview has no session for its workspace.";
  else if (type === "lumenize:logout") previewNotice.value = "You logged out inside the preview. Your Studio session is unchanged.";
}
onMounted(() => window.addEventListener("message", onFrameMessage));
onUnmounted(() => window.removeEventListener("message", onFrameMessage));

async function connect() {
  const n = createNebulaClient({
    ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
    ...chatPair(activeScope),
    // The build reply lands here: the Galaxy answers whoever asked for the build. The
    // initial load needs no cue — `dist/` serves from the Galaxy's VFS and the iframe
    // source is set below before anything is asked.
    onPreviewReady: (scope) => { if (scope === activeScope) reloadPreview(); },
  });
  await n.ready; // rejects with no session, after the client has sent this page to log in
  n.client.setOnStreamChunk((messageId, text, replyTo) => {
      // Render EVERY chunk — the thread is shared, so watching another participant's
      // reply appear is the product working. But only MY turn's chunks are liveness for
      // MY idle window: a message the single-flight latch skipped is never answered, and
      // re-arming it from someone else's running generation is a hang with no banner.
      // ⚠️ A KEEPALIVE carries no text — the server beats through the WHOLE turn, whose model
      // calls and builds are all silent (`turn-heartbeat.ts`). It re-arms the window below like a real
      // chunk, but must not paint: with nothing accumulated yet it would turn "thinking…" into an
      // empty bubble. Decided on the accumulated length, so a keepalive AFTER real chunks simply
      // re-paints the same text.
      if (text.length > 0) streaming.value = { id: messageId, text };
      if (turn.value && replyTo === lastPostedId.value) {
        turn.value = signalTurn(turn.value, Date.now());
      }
    });
  nebula.value = n;
  connected.value = true;
  if (isWorkspace(activeScope)) {
    previewSrc.value = devTabUrl(activeScope!); // render now; a build's reply refreshes it
    openChatThread(n.client);
  }
  await nudgeNextStep();
}

/** After connecting, prepare the view for the scope the URL named.
 *
 *  ⚠️ **No auto-forward — the URL is the view (ADR-017).** An account's host, `acme.lumenize.dev`,
 *  IS the Universe page: UniverseView renders the apps and the Create form, and *entering* an app is
 *  a navigation the person makes (a click → `enterScope` → the app's host). Forwarding a lone-app
 *  account into its Studio from here would show a view the address does not name; Home's
 *  fast-forward does that before any host is chosen. All this does is load the app list for
 *  UniverseView; a workspace just confirms it is ready. */
async function nudgeNextStep() {
  // A workspace is ready to chat. The empty-thread hint lives in the template (shown only
  // while the conversation has no content), so there is nothing to log here.
  if (isWorkspace(activeScope)) return;
  await loadUniverseApps(); // an empty list opens the Create form
}

onMounted(() => {
  if (!activeScope) return; // not a scope's host: nothing to connect to
  connecting.value = true;
  connect()
    .catch(() => { /* no session — the client has already sent this page to log in */ })
    .finally(() => {
      connecting.value = false;
    });
});

// Re-request the preview after a long absence. ⚠️ RE-DERIVED post-collapse: the original
// reason (waking an idle-slept dev container, which served a self-healing "waking" page) is
// GONE — the container is off the read path entirely and `dist` serves Galaxy-direct from
// the DO's VFS, so there is nothing to wake. The behavior survives on a DIFFERENT reason: a
// build that completes while this tab is hidden answers its requester with a direct push the
// client may miss if its gateway WS dropped, and a build another tab asked for sends this tab
// nothing, so on return the preview can be a version behind. Gated on a
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
  if (awayMs > 4 * 60_000 && connected.value && isWorkspace(activeScope)) {
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
    turnStartedAt.value = Date.now();
    nowTick.value = turnStartedAt.value;
  } catch (e) {
    log("error", `send failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function wipe() {
  if (!nebula.value || busy.value || !isWorkspace(activeScope)) return;
  busy.value = true;
  try {
    const client = nebula.value.client;
    // Fire-and-forget under the continuation-only model (no awaited callRaw). The wipe's
    // effect is reflected when the preview reloads; a dispatch failure is logged by the
    // framework, so the confirmation log here is optimistic.
    client.lmz.call("STAR", previewStar(activeScope!), client.ctn<Star>().resetDevData());
    log("studio", "Wiped the development test data.");
    reloadPreview();
  } catch (e) {
    log("error", `wipe failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

// ── The Universe page (UniverseView) — create an app, or open an existing one ──────────────────
const createError = ref<string | undefined>();

/** The apps under the account this page manages: the galaxies directly beneath this page's own
 *  scope, read through `expand`, whose parent is the token's `aud`. Empty once an account's last app
 *  is deleted — a claim writes the first — which is what makes the create modal open. */
const universeApps = ref<{ scope: string }[]>([]);
/** True once the list has loaded — distinct from an empty list, which UniverseView's empty state
 *  depends on. */
const universeAppsLoaded = ref(false);

async function loadUniverseApps() {
  const client = nebula.value?.client;
  if (!client) return;
  const apps: { scope: string }[] = [];
  let after: string | undefined;
  do {
    const page = await client.scopes.expand(after);
    apps.push(...page.children.filter((c) => c.tier === "galaxy").map((c) => ({ scope: c.scope })));
    after = page.nextCursor;
  } while (after);
  universeApps.value = apps;
  universeAppsLoaded.value = true;
}

/** The scope's page this page is entering once its host answers (`HostWait`). */
const waitingFor = ref<string | undefined>();

/** Open a scope's own page — its Studio for an app, its account page for a universe — once its host
 *  answers (`HostWait`): an app created moments ago may still be waiting for its certificate. A full
 *  load on another host: a different scope is a different socket and token, and the host IS the
 *  scope. */
function enterScope(scope: string): void {
  waitingFor.value = scopeUrl(scope);
}

/** Create the app, then NAVIGATE to its Studio, whose host a person can share (ADR-017), once that
 *  host answers: creating it ordered its certificate, which takes minutes to issue. The scope to
 *  open is the server's returned `instanceName`, not the typed slug, so the host can never disagree
 *  with what was created. `busy` stays set while the page waits, so the form cannot submit again. */
async function onCreateApp(slug: string) {
  const universe = activeScope;
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

/** Open an existing app's Studio (the FLAVOUR-B list). */
function onOpenApp(scope: string) {
  enterScope(scope);
}

/** Log out: the client sends this page to the platform host's logout page, which ends every
 *  session this browser holds, with ending them on every device already chosen when `everywhere`. */
async function logout(options: { everywhere?: boolean } = {}) {
  menuOpen.value = false;
  closeChatThread();
  const client = nebula.value?.client;
  if (client) await client.logout(options);
  else leaveTo(platformUrl(options.everywhere ? "/auth/logout?everywhere=1" : "/auth/logout"));
}

// ── Deleting: an app from its Studio (`?app`), an account from its page ─────────────────────────
// Each delete stands behind ConfirmDelete, which is component state and never the URL.

/** The app's settings are open: its tenants and its own delete. A workspace's overlay only. */
const appSettingsOpen = computed(() => overlay.value.app && connected.value && isWorkspace(activeScope));

/**
 * After this app is deleted, its account's page if the cookie behind this page's token opens it,
 * otherwise Home. An app's admin who holds nothing at the account would only meet a login there.
 */
function onAppDeleted() {
  const universe = activeScope!.split(".")[0];
  const access = (nebula.value?.client as { claims?: { access?: { authScope?: string; scopeAdmin?: boolean } } } | undefined)
    ?.claims?.access;
  const opens = access?.authScope !== undefined && !needsFreshLogin(
    { scope: universe, tier: "universe" }, [{ scope: access.authScope, scopeAdmin: access.scopeAdmin === true }]);
  leaveTo(opens ? scopeUrl(universe) : platformUrl("/"));
}

/** "Delete this account" was pressed on the universe page; the confirmation is open. */
const confirmingAccount = ref(false);
</script>

<template>
  <div class="h-screen flex">
    <!-- My profile — reached from the avatar menu, and the ONLY place these change after the
         consent screen collected them. NOT a gate: it opens on request and closes on Cancel, so it
         never stands between a person and their work the way the old completion modal did. -->
    <dialog class="modal" :open="profileOpen">
      <div class="modal-box">
        <h3 class="text-lg font-bold">Your profile</h3>
        <p class="py-2 text-sm opacity-80">How you appear to everyone you work with.</p>

        <div class="flex items-start gap-4 py-2">
          <div class="flex flex-col items-center gap-1 shrink-0">
            <label class="btn btn-ghost btn-circle size-16 cursor-pointer" data-testid="profile-avatar">
              <span class="sr-only">Change your picture</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                class="hidden"
                data-testid="profile-picture-input"
                :disabled="pictureUploading || profileSaving"
                @change="onPictureChosen"
              />
              <Loader2 v-if="pictureUploading" class="size-6 animate-spin" />
              <img
                v-else-if="profilePicture"
                :src="profilePicture"
                alt=""
                class="size-14 rounded-full object-cover"
                data-testid="profile-picture-img"
              />
              <span v-else class="size-14 rounded-full bg-neutral text-neutral-content grid place-items-center">
                <UserRound class="size-8" />
              </span>
            </label>
            <span class="text-xs opacity-60">Change</span>
          </div>

          <form class="flex-1 space-y-2" @submit.prevent="saveProfile">
            <fieldset class="fieldset">
              <legend class="fieldset-legend">Nickname</legend>
              <input
                v-model="profileNickname"
                type="text"
                class="input w-full"
                placeholder="Robin"
                :disabled="profileSaving"
                data-testid="profile-nickname"
                @input="profileDirty = true"
              />
            </fieldset>

            <fieldset class="fieldset">
              <legend class="fieldset-legend">Full name <span class="opacity-60">(optional)</span></legend>
              <input
                v-model="profileFullName"
                type="text"
                class="input w-full"
                placeholder="Robin Fielding"
                :disabled="profileSaving"
                data-testid="profile-name"
                @input="profileDirty = true"
              />
            </fieldset>
          </form>
        </div>

        <button type="button" class="btn btn-link btn-sm px-0" data-testid="profile-logout-everywhere"
          @click="logout({ everywhere: true })">
          Log out on every device
        </button>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="profileSaving" @click="closeProfile">
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm gap-2"
            :disabled="!canSaveProfile"
            data-testid="profile-save"
            @click="saveProfile"
          >
            <Loader2 v-if="profileSaving" class="size-4 animate-spin" /> Save
          </button>
        </div>
      </div>

    </dialog>

    <!-- The full live transcript — opened from the strip; scrolls with the stream. -->
    <dialog class="modal" :open="streamModalOpen" @cancel.prevent="closeStreamModal">
      <div class="modal-box max-w-3xl">
        <h3 class="text-lg font-bold">What Lumenize is thinking</h3>
        <p v-if="transcriptMissing" class="mt-3 text-sm opacity-70" data-testid="stream-transcript-missing">This page did not see that message being written.</p>
        <pre v-else ref="transcriptEl" class="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-base-200 p-3 font-mono text-xs" data-testid="stream-transcript">{{ streamTranscript || "(nothing yet)" }}</pre>
        <div class="modal-action">
          <button type="button" class="btn btn-sm" data-testid="stream-transcript-close" @click="closeStreamModal">Close</button>
        </div>
      </div>
    </dialog>

    <!-- Chat rail -->
    <!-- The chat rail exists only inside a workspace on a live session. A Universe has no chat — it
         renders UniverseView full-width in the stage — so it renders the stage alone. -->
    <section v-if="connected && isWorkspace(activeScope)" class="w-112 shrink-0 flex flex-col border-r border-base-300 bg-base-200">
      <header class="p-4 border-b border-base-300 flex items-center justify-between">
        <h1 class="text-lg font-bold">Lumenize Studio</h1>
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
            <!-- The faces behind the byline. Rendered back-to-front so the actor paints on top; the
                 subject sits offset by a third of its width, enough to read and to hover. -->
            <div class="chat-image">
              <div :class="['relative h-8', m.stack.length > 1 ? 'w-11' : 'w-8']" data-testid="party-stack" :data-parties="m.stack.length">
                <span
                  v-for="(p, i) in [...m.stack].reverse()"
                  :key="i"
                  :class="['absolute top-0', i === m.stack.length - 1 ? 'left-0 z-10' : 'left-3 z-0']"
                  :title="p.title ?? p.name"
                  data-testid="party-avatar"
                  :data-name="p.name"
                >
                  <img v-if="p.picture" :src="p.picture" alt="" class="size-8 rounded-full object-cover ring-2 ring-base-200 bg-base-200" data-testid="party-avatar-img" />
                  <span v-else :class="['size-8 rounded-full grid place-items-center text-xs font-semibold ring-2 ring-base-200', p.kind === 'agent' ? 'bg-primary text-primary-content' : 'bg-neutral text-neutral-content']">
                    {{ (p.name.trim().charAt(0) || '?').toUpperCase() }}
                  </span>
                </span>
              </div>
            </div>
            <div class="chat-header text-xs opacity-60 mb-0.5" :title="m.title" data-testid="byline">{{ m.byline }}</div>
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
          <div class="chat-header text-xs opacity-60 mb-0.5">Lumenize</div>
          <!-- The strip: a pulse, the tail of what is being written, and a click to read it all. -->
          <button
            type="button"
            class="chat-bubble flex items-center gap-2 text-left max-w-full"
            data-testid="stream-strip"
            title="Click to read the full transcript"
            @click="openStreamModal"
          >
            <span class="inline-block size-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true"></span>
            <span class="shrink-0 text-xs opacity-70">Lumenize is thinking</span>
            <span class="truncate font-mono text-xs opacity-80" data-testid="stream-tail">{{ streamTail }}</span>
          </button>
        </div>
        <div v-else-if="turnDisplay === 'failed'" class="chat chat-start">
          <div class="chat-bubble chat-bubble-error text-sm">
            No reply arrived — this turn may have been lost. Re-send your message to try again.
          </div>
        </div>
        <div v-else-if="turnDisplay === 'thinking'" class="chat chat-start">
          <div class="chat-bubble flex items-center gap-2" data-testid="turn-thinking">
            <Loader2 class="size-4 animate-spin" /> Studio is thinking… <span class="opacity-60 tabular-nums">{{ elapsedSec }}s</span>
          </div>
        </div>
        <!-- Local notices (login guidance, nudges, errors) — never the conversation. -->
        <template v-for="(m, i) in messages" :key="'n' + i">
          <div :class="['chat', 'chat-start']">
            <div :class="['chat-bubble', m.role === 'error' ? 'chat-bubble-error' : '']">{{ m.text }}</div>
          </div>
        </template>
      </div>

      <footer class="p-4 border-t border-base-300">
        <form class="flex gap-2 items-end" @submit.prevent="send">
          <!-- Wrapping composer: a textarea wraps long input instead of scrolling sideways.
               Enter sends; Shift+Enter inserts a newline. `field-sizing` auto-grows it. -->
          <textarea
            v-model="input"
            class="textarea flex-1 resize-none max-h-40 field-sizing-content"
            rows="1"
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

    <!-- Stage: account bar + the Universe page / preview -->
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
          <img v-if="myProfile?.picture" :src="myProfile.picture" :alt="myProfile?.name ?? ''" :title="myProfile?.name" class="size-7 rounded-full object-cover" data-testid="account-picture" />
          <span v-else class="inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-content"><User class="size-4" /></span>
        </button>
        <div v-if="menuOpen" class="absolute right-2 top-12 z-20 w-60 p-1 rounded-box border border-base-300 bg-base-200 shadow-lg flex flex-col">
          <button class="btn btn-sm btn-ghost justify-start" @click="goHome"><Home class="size-4" /> Home</button>
          <button class="btn btn-sm btn-ghost justify-start" data-testid="menu-profile" @click="openProfile"><UserRound class="size-4" /> Profile</button>
          <button v-if="isWorkspace(activeScope)" class="btn btn-sm btn-ghost justify-start" data-testid="menu-app"
            @click="menuOpen = false; navigate({ app: true })"><Settings class="size-4" /> App settings</button>
          <a class="btn btn-sm btn-ghost justify-start" :href="platformUrl('/auth/emails')"><Mail class="size-4" /> Email addresses</a>
          <div class="divider my-0"></div>
          <!-- One logout: it ends every session this browser holds, on the platform host's logout
               page, which also offers ending them on every device. -->
          <button class="btn btn-sm btn-ghost justify-start" data-testid="menu-logout" @click="logout"><LogOut class="size-4" /> Log out</button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto">
        <!-- Deleting, behind confirmations that never ride the URL. Outside the chain below, whose
             v-else belongs to the universe page's v-else-if. -->
        <ConfirmDelete
          v-if="confirmingAccount && stageMode === 'universe' && activeScope && nebula"
          :target="activeScope"
          what="this account"
          :scopes="nebula.client.scopes"
          @deleted="leaveTo(platformUrl('/'))"
          @cancel="confirmingAccount = false"
        />
        <HostWait v-if="waitingFor" :url="waitingFor" />
        <AppSettings
          v-if="appSettingsOpen && activeScope && nebula"
          :galaxy="activeScope"
          :scopes="nebula.client.scopes"
          @close="navigate({ app: false })"
          @app-deleted="onAppDeleted"
        />

        <!-- Until the client connects. With no session it has already sent this page to log in. -->
        <div v-if="stageMode === 'connecting'" class="p-8 flex items-center gap-2 text-sm opacity-80" data-testid="connecting">
          <Loader2 class="size-4 animate-spin" /> Signing you in…
        </div>

        <!-- The Universe page: create an app, or open an existing one. -->
        <UniverseView
          v-else-if="stageMode === 'universe' && activeScope"
          :universe="activeScope"
          :apps="universeApps"
          :ready="universeAppsLoaded"
          :create="overlay.create"
          :busy="busy"
          :error="createError"
          @create="onCreateApp"
          @create-open="(auto) => navigate({ create: true }, { replace: auto })"
          @create-close="navigate({ create: false })"
          @open="onOpenApp"
          @delete-account="confirmingAccount = true"
        />

        <!-- Live preview: the dev Star's own host, the one page this Studio frames. -->
        <div v-else class="w-full h-full flex flex-col">
          <p v-if="previewNotice" class="alert alert-info text-sm rounded-none" data-testid="preview-notice">{{ previewNotice }}</p>
          <iframe ref="previewFrame" :src="previewSrc" class="w-full flex-1 border-0" title="Preview" />
        </div>
      </div>
    </section>
  </div>
</template>
