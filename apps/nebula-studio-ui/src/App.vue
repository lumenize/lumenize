<script setup lang="ts">
import { ref, shallowRef, onMounted } from "vue";
import { Send, RotateCcw, LogIn, Loader2, User, LogOut, Trash2, ChevronLeft } from "lucide-vue-next";
import { createNebulaClient } from "@lumenize/nebula/frontend";
// Type-only (erased at build — does NOT pull cloudflare:workers into the browser bundle).
import type { DevStudio, Star } from "@lumenize/nebula";

// Every actor (real users, tests, you) self-provisions ONE uniform way — real-email magic-link
// login → discovery resolves your scope → (first-run) claim a slug. No hardcoded scope, no
// test-mode shortcut (B2, tasks/nebula-release-process.md).
//
// `scope` is the {u}.{g}.dev / {u} instance the Studio talks to (DevStudio / DevContainer / Star).
// It comes from, in order: an explicit `?scope=` override (the Playwright ui-smoke + manual
// debugging drive a dedicated `test-…` sandbox this way), then a returning session's remembered
// scope (localStorage), else it's resolved from discovery when you log in.
const SCOPE_KEY = "nebula.scope";
const urlScope = new URLSearchParams(location.search).get("scope") ?? undefined;
const scope = ref<string | undefined>(urlScope ?? localStorage.getItem(SCOPE_KEY) ?? undefined);

type Msg = { role: "you" | "studio" | "error" | "thought"; text: string };
const messages = ref<Msg[]>([]);
const input = ref("");
const connected = ref(false);
const busy = ref(false);
const thinking = ref(false); // model is generating — shows the "Studio is thinking…" indicator
const previewSrc = ref(""); // set once a scope is resolved + connected
const nebula = shallowRef<ReturnType<typeof createNebulaClient> | null>(null);

// --- Login state ---
const email = ref("");
const sentTo = ref<string | null>(null); // "magic link sent to X" confirmation
const needsClaim = ref(false); // discovery returned 0 scopes → show the claim-a-slug input
const claimSlug = ref("");

// --- Account / manage-scopes state ---
const menuOpen = ref(false); // account dropdown
const manageOpen = ref(false); // the big pane shows Manage-my-scopes instead of the preview
const accountEmail = ref<string | null>(null);
const scopes = ref<{ instanceName: string; isAdmin: boolean }[]>([]);
type AffectedScope = { instanceName: string; tier: string; isDev: boolean };
type DeletionPlan = { affected: AffectedScope[]; blockedBy: { instanceName: string; email: string }[] };
const deleteTarget = ref<string | null>(null);
const deletePlan = ref<DeletionPlan | null>(null);

const log = (role: Msg["role"], text: string) => messages.value.push({ role, text });

/** Force the preview iframe to re-fetch (HMR-under-prefix is deferred, so a source
 *  change needs a reload to show). */
function reloadPreview() {
  if (scope.value) previewSrc.value = `/dev-container/${scope.value}/?t=${Date.now()}`;
}

/** Remember the resolved scope BEFORE the magic-link round-trip, so the post-redirect reload
 *  (landing at NEBULA_AUTH_REDIRECT, no `?scope=`) can auto-connect to it. */
function rememberScope(s: string) {
  scope.value = s;
  localStorage.setItem(SCOPE_KEY, s);
}

/** Unauthenticated, email-keyed scope discovery (precedes any token). */
async function discover(emailAddr: string): Promise<{ instanceName: string; isAdmin: boolean }[]> {
  const res = await fetch(`/auth/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailAddr }),
  });
  if (!res.ok) throw new Error(`discover ${res.status}: ${await res.text().catch(() => "")}`);
  return (await res.json()) as { instanceName: string; isAdmin: boolean }[];
}

/** Real-email login: resolve the scope (explicit `?scope=` wins, else discovery), then send the
 *  magic link to it. Clicking the emailed link sets the per-scope refresh cookie and lands here. */
async function sendMagicLink() {
  const e = email.value.trim();
  if (!e || busy.value) return;
  busy.value = true;
  try {
    let target = urlScope; // explicit `?scope=` (ui-smoke / manual debug) bypasses discovery
    if (!target) {
      const entries = await discover(e);
      if (entries.length === 1) {
        target = entries[0]!.instanceName;
      } else if (entries.length === 0) {
        needsClaim.value = true; // first-run — offer to claim a slug
        return;
      } else {
        // >1 scope → the discovery picker is a Wave-2 UI; not built this round.
        log("error", `${entries.length} workspaces found for ${e} — the picker is a later feature. Use ?scope= for now.`);
        return;
      }
    }
    rememberScope(target);
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

/** First-run (no scope for this email yet): claim a Universe slug. `claim-universe` also sends the
 *  magic link, so the flow continues identically to a returning login. */
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
    rememberScope(slug);
    needsClaim.value = false;
    sentTo.value = e;
  } catch (err) {
    log("error", `Claim failed: ${(err as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function connect() {
  if (!scope.value) throw new Error("no scope to connect to");
  const n = createNebulaClient({
    authScope: scope.value,
    activeScope: scope.value,
    appVersion: "studio-ui", // the Studio UI calls DevStudio, not the ontology — never version-checked
  });
  await n.ready; // throws if not authenticated (no / expired refresh cookie)
  nebula.value = n; // only adopt the client once the session is live
  connected.value = true;
  previewSrc.value = `/dev-container/${scope.value}/`;
  localStorage.setItem(SCOPE_KEY, scope.value); // remember for the next visit
  log("studio", "Connected. Describe the app you want to build.");
}

// Auto-connect when a scope is known (explicit `?scope=`, or a remembered session) AND a valid
// refresh cookie is already present — a returning session, or the ui-smoke that logs in
// out-of-band (real magic-link) then loads the Studio. Falls back to the login form otherwise.
onMounted(() => {
  if (!scope.value) return; // no known scope yet → show the email-login form
  connect().catch(() => {
    /* not authenticated — show the login form */
  });
});

async function send() {
  const msg = input.value.trim();
  if (!msg || !nebula.value || busy.value) return;
  log("you", msg);
  input.value = "";
  busy.value = true;
  thinking.value = true;
  try {
    const client = nebula.value.client;
    const reply = (await client.lmz.callRaw(
      "DEV_STUDIO",
      scope.value!,
      client.ctn<DevStudio>().chat(msg),
    )) as { reply: string; thought: string };
    thinking.value = false;
    if (reply.thought) log("thought", reply.thought); // raw model output — collapsible, for prompt iteration
    log("studio", reply.reply);
    reloadPreview();
  } catch (e) {
    log("error", `chat failed: ${(e as Error).message}`);
  } finally {
    thinking.value = false;
    busy.value = false;
  }
}

async function wipe() {
  if (!nebula.value || busy.value) return;
  busy.value = true;
  try {
    const client = nebula.value.client;
    await client.lmz.callRaw("STAR", scope.value!, client.ctn<Star>().resetDevData());
    log("studio", "Wiped .dev data.");
    reloadPreview();
  } catch (e) {
    log("error", `wipe failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

// ─── Account + Manage my scopes ──────────────────────────────────────────────

/** Mint a short-lived access token from the (HttpOnly) refresh cookie for the connected scope —
 *  used as the Bearer for the authed `delete-scope*` routes (the registry is HTTP, not mesh). */
async function getAccessToken(): Promise<string> {
  if (!scope.value) throw new Error("not connected");
  const res = await fetch(`/auth/${scope.value}/refresh-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ activeScope: scope.value }),
  });
  if (!res.ok) throw new Error(`refresh ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Read the (already-verified-server-side) email claim out of the access token — used to list the
 *  caller's own scopes via discovery. No client-side trust: the server re-verifies on every route. */
function emailFromToken(token: string): string | undefined {
  try {
    const part = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(atob(part)) as { email?: string }).email;
  } catch {
    return undefined;
  }
}

async function openManage() {
  menuOpen.value = false;
  manageOpen.value = true;
  deletePlan.value = null;
  deleteTarget.value = null;
  busy.value = true;
  try {
    const token = await getAccessToken();
    accountEmail.value = emailFromToken(token) ?? null;
    scopes.value = accountEmail.value ? await discover(accountEmail.value) : [];
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
}

/** Open the destructive-delete confirm screen — fetches the exact cascade PLAN (down + prune-up +
 *  other-user blockers) so you eyeball precisely what gets wiped before arming the button. */
async function openDeleteConfirm(target: string) {
  busy.value = true;
  try {
    const token = await getAccessToken();
    const res = await fetch(`/auth/delete-scope-plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ target }),
    });
    if (!res.ok) throw new Error(`plan ${res.status}: ${await res.text().catch(() => "")}`);
    deletePlan.value = (await res.json()) as DeletionPlan;
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
  if (!target || !plan || plan.blockedBy.length > 0 || busy.value) return;
  busy.value = true;
  try {
    const token = await getAccessToken();
    // 1. Registry clears its own rows + the per-scope NebulaAuth subjects (→ discovery goes empty).
    const res = await fetch(`/auth/delete-scope`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ target }),
    });
    if (!res.ok) throw new Error(`delete ${res.status}: ${await res.text().catch(() => "")}`);
    const { affected } = (await res.json()) as { affected: AffectedScope[] };

    // 2. Fan out the platform-DO teardown via mesh (the registry can't reach platform DOs).
    const client = nebula.value?.client;
    if (client) {
      const ctnT = () => client.ctn<{ teardown(): Promise<void> }>().teardown();
      for (const a of affected) {
        const binding = a.tier === "universe" ? "UNIVERSE" : a.tier === "galaxy" ? "GALAXY" : "STAR";
        await client.lmz.callRaw(binding, a.instanceName, ctnT()).catch(() => {});
        if (a.isDev) {
          await client.lmz.callRaw("DEV_STUDIO", a.instanceName, ctnT()).catch(() => {});
          await client.lmz.callRaw("DEV_CONTAINER", a.instanceName, ctnT()).catch(() => {});
        }
      }
    }

    if (affected.some((a) => a.instanceName === scope.value)) {
      resetToLoggedOut(); // we just deleted the scope we were in → back to a clean first-run
    } else {
      cancelDelete();
      await openManage(); // refresh the remaining list
    }
  } catch (e) {
    log("error", `Delete failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

function resetToLoggedOut() {
  localStorage.removeItem(SCOPE_KEY);
  menuOpen.value = false;
  manageOpen.value = false;
  deletePlan.value = null;
  deleteTarget.value = null;
  connected.value = false;
  nebula.value = null;
  scope.value = undefined;
  previewSrc.value = "";
  messages.value = [];
  sentTo.value = null;
  needsClaim.value = false;
  accountEmail.value = null;
  scopes.value = [];
}

async function logout() {
  menuOpen.value = false;
  try {
    await (nebula.value?.client as { logout?: () => Promise<void> } | undefined)?.logout?.();
  } catch {
    /* best-effort — clear local state regardless */
  }
  resetToLoggedOut();
}
</script>

<template>
  <div class="h-screen flex" data-theme="dark">
    <!-- Chat pane -->
    <section class="w-[28rem] shrink-0 flex flex-col border-r border-base-300 bg-base-200">
      <header class="p-4 border-b border-base-300 flex items-center justify-between">
        <h1 class="text-lg font-bold">Nebula Studio</h1>
        <button class="btn btn-sm btn-ghost" :disabled="busy || !connected" title="Wipe .dev data" @click="wipe">
          <RotateCcw class="size-4" /> Wipe
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        <template v-for="(m, i) in messages" :key="i">
          <!-- Raw model output — collapsed by default; expand to inspect + iterate the prompt. -->
          <details v-if="m.role === 'thought'" class="text-xs opacity-70">
            <summary class="cursor-pointer select-none">💭 Studio's thought process</summary>
            <pre class="mt-2 whitespace-pre-wrap break-words bg-base-300 rounded p-2 max-h-80 overflow-auto">{{ m.text }}</pre>
          </details>
          <div v-else :class="['chat', m.role === 'you' ? 'chat-end' : 'chat-start']">
            <div
              :class="[
                'chat-bubble',
                m.role === 'error' ? 'chat-bubble-error' : m.role === 'you' ? 'chat-bubble-primary' : '',
              ]"
            >
              {{ m.text }}
            </div>
          </div>
        </template>
        <!-- Waiting indicator while the model generates. -->
        <div v-if="thinking" class="chat chat-start">
          <div class="chat-bubble flex items-center gap-2">
            <Loader2 class="size-4 animate-spin" /> Studio is thinking…
          </div>
        </div>
      </div>

      <footer class="p-4 border-t border-base-300">
        <!-- Unauthenticated: real-email magic-link login (+ a minimal first-run slug claim). -->
        <div v-if="!connected" class="flex flex-col gap-2">
          <p v-if="sentTo" class="text-sm opacity-80">
            Magic link sent to <span class="font-mono">{{ sentTo }}</span> — check your email to finish signing in.
          </p>
          <template v-else>
            <!-- Email → "send magic link". This is the unique unauthenticated control. -->
            <form v-if="!needsClaim" class="flex flex-col gap-2" @submit.prevent="sendMagicLink">
              <input
                v-model="email"
                type="email"
                class="input input-bordered"
                placeholder="you@example.com"
                :disabled="busy"
              />
              <button class="btn btn-primary" :disabled="busy || !email.trim()">
                <Loader2 v-if="busy" class="size-4 animate-spin" />
                <LogIn v-else class="size-4" />
                Send magic link
              </button>
            </form>
            <!-- First-run: no workspace for this email yet → claim a Universe slug. -->
            <form v-else class="flex flex-col gap-2" @submit.prevent="claimUniverse">
              <p class="text-sm opacity-80">No workspace yet — claim one:</p>
              <input
                v-model="claimSlug"
                class="input input-bordered"
                placeholder="your-universe-slug"
                :disabled="busy"
              />
              <button class="btn btn-primary" :disabled="busy || !claimSlug.trim()">
                <Loader2 v-if="busy" class="size-4 animate-spin" />
                <LogIn v-else class="size-4" />
                Claim &amp; send magic link
              </button>
            </form>
          </template>
        </div>
        <!-- Authenticated: the chat composer. -->
        <form v-else class="flex gap-2" @submit.prevent="send">
          <input
            v-model="input"
            class="input input-bordered flex-1"
            placeholder="Describe a change…"
            :disabled="busy"
          />
          <button class="btn btn-primary" :disabled="busy || !input.trim()">
            <Loader2 v-if="busy" class="size-4 animate-spin" />
            <Send v-else class="size-4" />
          </button>
        </form>
      </footer>
    </section>

    <!-- Stage pane: account bar (top-right) + preview OR manage-my-scopes -->
    <section class="flex-1 bg-base-100 flex flex-col min-w-0">
      <!-- Account bar — only once connected. The avatar menu is the persistent account control. -->
      <div v-if="connected" class="relative flex items-center justify-end px-3 py-2 border-b border-base-300">
        <button class="btn btn-sm btn-ghost gap-2" title="Account" @click="menuOpen = !menuOpen">
          <span v-if="accountEmail" class="text-xs opacity-60">{{ accountEmail }}</span>
          <span class="inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-content">
            <User class="size-4" />
          </span>
        </button>
        <div
          v-if="menuOpen"
          class="absolute right-2 top-12 z-20 w-52 p-1 rounded-box border border-base-300 bg-base-200 shadow-lg flex flex-col"
        >
          <button class="btn btn-sm btn-ghost justify-start" @click="openManage">Manage my scopes</button>
          <button class="btn btn-sm btn-ghost justify-start" @click="logout">
            <LogOut class="size-4" /> Log out
          </button>
        </div>
      </div>

      <!-- Manage my scopes (the stage switches contents) OR the live preview. -->
      <div class="flex-1 min-h-0 overflow-auto">
        <div v-if="manageOpen" class="p-6 flex flex-col gap-4 max-w-2xl">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold">Manage my scopes</h2>
            <button class="btn btn-sm btn-ghost" @click="closeManage"><ChevronLeft class="size-4" /> Preview</button>
          </div>
          <p v-if="accountEmail" class="text-sm opacity-70">Signed in as <span class="font-mono">{{ accountEmail }}</span></p>

          <!-- Destructive confirm — shows the EXACT cascade before arming the button. -->
          <div v-if="deletePlan" class="border border-error/60 rounded-box p-4 flex flex-col gap-3">
            <p class="font-medium">Delete <span class="font-mono">{{ deleteTarget }}</span>?</p>
            <p class="text-sm opacity-80">This permanently wipes (no undo — soft-delete/restore is a later feature):</p>
            <ul class="text-sm flex flex-col gap-1">
              <li v-for="a in deletePlan.affected" :key="a.instanceName">
                <span class="font-mono">{{ a.instanceName }}</span>
                <span class="opacity-50">({{ a.tier }}{{ a.isDev ? " · dev" : "" }})</span>
              </li>
            </ul>
            <p v-if="deletePlan.blockedBy.length" class="text-sm text-error">
              Blocked — other users are attached to
              {{ deletePlan.blockedBy.map((b) => `${b.instanceName} (${b.email})`).join(", ") }}.
            </p>
            <p v-else class="text-sm text-success">No other users — safe to wipe.</p>
            <div class="flex gap-2">
              <button class="btn btn-sm" :disabled="busy" @click="cancelDelete">Cancel</button>
              <button
                class="btn btn-sm btn-error"
                :disabled="busy || deletePlan.blockedBy.length > 0"
                @click="confirmDelete"
              >
                <Loader2 v-if="busy" class="size-4 animate-spin" />
                <Trash2 v-else class="size-4" />
                Delete permanently
              </button>
            </div>
          </div>

          <!-- Scope list. -->
          <div v-else class="flex flex-col gap-2">
            <p v-if="!scopes.length && !busy" class="text-sm opacity-60">No scopes yet.</p>
            <div
              v-for="s in scopes"
              :key="s.instanceName"
              class="flex items-center justify-between border border-base-300 rounded-box p-3"
            >
              <span class="font-mono text-sm">{{ s.instanceName }}</span>
              <button
                class="btn btn-xs btn-ghost text-error"
                :disabled="busy"
                title="Delete scope"
                @click="openDeleteConfirm(s.instanceName)"
              >
                <Trash2 class="size-4" />
              </button>
            </div>
          </div>
        </div>

        <iframe v-else :src="previewSrc" class="w-full h-full border-0" title="Preview" />
      </div>
    </section>
  </div>
</template>
