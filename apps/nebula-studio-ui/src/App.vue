<script setup lang="ts">
import { ref, shallowRef, computed, onMounted } from "vue";
import { Send, RotateCcw, LogIn, Loader2, User, LogOut, Trash2, ChevronLeft, Plus, FolderOpen } from "lucide-vue-next";
import { createNebulaClient } from "@lumenize/nebula/frontend";
// Type-only (erased at build — does NOT pull cloudflare:workers into the browser bundle).
import type { DevStudio, Star } from "@lumenize/nebula";

// You build your hierarchy explicitly — claim a Universe, add a Galaxy, add a `.dev` Star, open it
// to author. No magic first-run, no `?scope=` sidestep (tasks/nebula-release-process.md § B2 + the
// hierarchy-builder sidebar). `authScope` = where you logged in (the refresh-cookie scope);
// `activeScope` = the scope you're working IN (a `.dev` Star under your authority). They differ once
// you "open" a Star: your Universe cookie mints a token whose admin pattern reaches the Star.
const SCOPE_KEY = "nebula.authScope";
const urlScope = new URLSearchParams(location.search).get("scope") ?? undefined;
const authScope = ref<string | undefined>(urlScope ?? localStorage.getItem(SCOPE_KEY) ?? undefined);
const activeScope = ref<string | undefined>(authScope.value);

type Msg = { role: "you" | "studio" | "error" | "thought"; text: string };
const messages = ref<Msg[]>([]);
const input = ref("");
const connected = ref(false);
const connecting = ref(false); // post-magic-link auto-connect in flight (shows "Signing you in…")
const busy = ref(false);
const thinking = ref(false);
const previewSrc = ref("");
const nebula = shallowRef<ReturnType<typeof createNebulaClient> | null>(null);

// login
const email = ref("");
const sentTo = ref<string | null>(null);
const needsClaim = ref(false);
const claimSlug = ref("");

// account / hierarchy
const menuOpen = ref(false);
const manageOpen = ref(false);
const accountEmail = ref<string | null>(null);
type Scope = { instanceName: string; tier: string; isDev: boolean };
const scopes = ref<Scope[]>([]);
const addChildFor = ref<string | null>(null); // a Universe row whose "name a Galaxy" input is open
const addChildSlug = ref("");
type DeletionPlan = { affected: Scope[]; blockedBy: { instanceName: string; email: string }[] };
const deleteTarget = ref<string | null>(null);
const deletePlan = ref<DeletionPlan | null>(null);

const log = (role: Msg["role"], text: string) => messages.value.push({ role, text });

const isDevStar = (s?: string) => !!s && s.split(".").length === 3 && s.endsWith(".dev");
// Stage content: the hierarchy manager (opened from the avatar menu) > the live preview (only when
// you're inside a `.dev` Star) > the Universe/Galaxy/Star help (the default, incl. first use).
const stageMode = computed<"manage" | "preview" | "help">(() =>
  manageOpen.value ? "manage" : connected.value && isDevStar(activeScope.value) ? "preview" : "help",
);

// A session worth a "Log out" affordance even before the WS connects (e.g. a stale cookie that
// failed to auto-connect, or a half-finished login) — so logout never vanishes when the avatar does.
const hasSession = computed(() => !!(authScope.value || localStorage.getItem(SCOPE_KEY)));

function reloadPreview() {
  if (activeScope.value) previewSrc.value = `/dev-container/${activeScope.value}/?t=${Date.now()}`;
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
async function discover(emailAddr: string): Promise<{ instanceName: string; isAdmin: boolean }[]> {
  const res = await fetch(`/auth/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailAddr }),
  });
  if (!res.ok) throw new Error(`discover ${res.status}: ${await res.text().catch(() => "")}`);
  return (await res.json()) as { instanceName: string; isAdmin: boolean }[];
}

function rememberAuthScope(s: string) {
  authScope.value = s;
  activeScope.value = s;
  localStorage.setItem(SCOPE_KEY, s);
}

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
        claimSlug.value = suggestUniverseSlug(e); // prefill the suggestion
        needsClaim.value = true;
        return;
      } else {
        log("error", `${entries.length} workspaces for ${e} — the picker is a later feature. Use ?scope= for now.`);
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

async function connect() {
  if (!authScope.value) throw new Error("no scope to connect to");
  if (!activeScope.value) activeScope.value = authScope.value;
  const n = createNebulaClient({
    authScope: authScope.value,
    activeScope: activeScope.value,
    appVersion: "studio-ui",
  });
  await n.ready; // throws if not authenticated
  nebula.value = n;
  connected.value = true;
  if (isDevStar(activeScope.value)) previewSrc.value = `/dev-container/${activeScope.value}/`;
  localStorage.setItem(SCOPE_KEY, authScope.value);
  await nudgeNextStep();
}

/** Guide the user to their next step from the SERVER tree (not local state — the magic link opens a
 *  fresh tab). In a `.dev` Star → ready to author. At a Universe → nudge them to create/open an app
 *  right here in the chat ("B" — the frictionless first-use guidance). */
async function nudgeNextStep() {
  if (isDevStar(activeScope.value)) {
    log("studio", "Connected. Describe the app you want to build.");
    return;
  }
  try {
    const list = await nebula.value!.client.scopes.list();
    scopes.value = list.sort((a, b) => a.instanceName.localeCompare(b.instanceName));
    const hasApp = list.some((s) => s.tier === "galaxy");
    log(
      "studio",
      hasApp
        ? "Welcome back. Type a name below to spin up a new app, or open an existing one from “Manage my scopes” (top right)."
        : "Welcome! Let’s create your first app — type a name for it below and I’ll set it up for you.",
    );
  } catch {
    log("studio", "Welcome! Type a name for your first app below to get started.");
  }
}

onMounted(() => {
  if (!authScope.value) return;
  connecting.value = true;
  connect()
    .catch(() => {
      /* not authenticated — show the login form */
    })
    .finally(() => {
      connecting.value = false;
    });
});

async function send() {
  const msg = input.value.trim();
  if (!msg || !nebula.value || busy.value) return;
  if (!isDevStar(activeScope.value)) {
    // At a Universe — the composer creates an app (guided first-run "B") instead of chatting.
    input.value = "";
    await createApp(msg);
    return;
  }
  log("you", msg);
  input.value = "";
  busy.value = true;
  thinking.value = true;
  try {
    const client = nebula.value.client;
    const reply = (await client.lmz.callRaw(
      "DEV_STUDIO",
      activeScope.value!,
      client.ctn<DevStudio>().chat(msg),
    )) as { reply: string; thought: string };
    thinking.value = false;
    if (reply.thought) log("thought", reply.thought);
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
  if (!nebula.value || busy.value || !isDevStar(activeScope.value)) return;
  busy.value = true;
  try {
    const client = nebula.value.client;
    await client.lmz.callRaw("STAR", activeScope.value!, client.ctn<Star>().resetDevData());
    log("studio", "Wiped .dev data.");
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

/** Indent depth for the tree (universe 0, galaxy 1, star 2). */
const depth = (s: Scope) => s.instanceName.split(".").length - 1;
/** A galaxy already has its `.dev` authoring Star → show "Open" on it, not "+ add Star". */
const hasDevStar = (galaxy: string) => scopes.value.some((s) => s.instanceName === `${galaxy}.dev`);

async function addGalaxy(universe: string) {
  const slug = addChildSlug.value.trim();
  if (!slug || busy.value) return;
  busy.value = true;
  try {
    await nebula.value!.client.scopes.createGalaxy(universe, slug);
    addChildFor.value = null;
    addChildSlug.value = "";
    await loadScopes();
  } catch (e) {
    log("error", `Could not add galaxy: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function addStar(galaxy: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    await nebula.value!.client.scopes.createStar(galaxy);
    await loadScopes();
  } catch (e) {
    log("error", `Could not add star: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

/** Enter a `.dev` Star to author: switch the working scope + reconnect (authScope/cookie unchanged;
 *  our admin token reaches it). */
async function openStar(star: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    try {
      await (nebula.value?.client as { disconnect?: () => unknown } | undefined)?.disconnect?.();
    } catch {
      /* old WS best-effort */
    }
    activeScope.value = star;
    const n = createNebulaClient({ authScope: authScope.value!, activeScope: star, appVersion: "studio-ui" });
    await n.ready;
    nebula.value = n;
    previewSrc.value = `/dev-container/${star}/`;
    messages.value = [];
    manageOpen.value = false;
  } catch (e) {
    log("error", `Could not open ${star}: ${(e as Error).message}`);
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
    await nebula.value!.client.scopes.createStar(`${universe}.${slug}`);
  } catch (e) {
    log("error", `Could not create app: ${(e as Error).message}`);
    busy.value = false;
    return;
  }
  busy.value = false;
  await openStar(`${universe}.${slug}.dev`); // reconnects + clears chat + manages its own busy
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
  if (!target || !plan || plan.blockedBy.length > 0 || busy.value) return;
  busy.value = true;
  try {
    const { affected } = await nebula.value!.client.scopes.delete(target);
    // Fan out the platform-DO teardown via mesh (the registry cleared its own rows already).
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
  localStorage.removeItem(SCOPE_KEY);
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
  const scope = authScope.value ?? localStorage.getItem(SCOPE_KEY) ?? undefined;
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
          v-if="isDevStar(activeScope)"
          class="btn btn-sm btn-ghost"
          :disabled="busy || !connected"
          title="Wipe .dev data"
          @click="wipe"
        >
          <RotateCcw class="size-4" /> Wipe
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        <template v-for="(m, i) in messages" :key="i">
          <details v-if="m.role === 'thought'" class="text-xs opacity-70">
            <summary class="cursor-pointer select-none">💭 Studio's thought process</summary>
            <pre class="mt-2 whitespace-pre-wrap break-words bg-base-300 rounded p-2 max-h-80 overflow-auto">{{ m.text }}</pre>
          </details>
          <div v-else :class="['chat', m.role === 'you' ? 'chat-end' : 'chat-start']">
            <div
              :class="['chat-bubble', m.role === 'error' ? 'chat-bubble-error' : m.role === 'you' ? 'chat-bubble-primary' : '']"
            >
              {{ m.text }}
            </div>
          </div>
        </template>
        <div v-if="thinking" class="chat chat-start">
          <div class="chat-bubble flex items-center gap-2"><Loader2 class="size-4 animate-spin" /> Studio is thinking…</div>
        </div>
      </div>

      <footer class="p-4 border-t border-base-300">
        <!-- Unauthenticated: email magic-link login (+ a first-run Universe claim). -->
        <div v-if="!connected" class="flex flex-col gap-2">
          <!-- Post-magic-link auto-connect in flight — don't flash the login form. -->
          <div v-if="connecting" class="flex items-center gap-2 text-sm opacity-80 py-2">
            <Loader2 class="size-4 animate-spin" /> Signing you in…
          </div>
          <template v-else>
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
            :placeholder="isDevStar(activeScope) ? 'Describe a change…' : 'Name your app to create it…'"
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
              <p class="font-medium">⭐ Star — a workspace</p>
              <p class="text-sm opacity-80 mt-1">Your app's <span class="font-mono">.dev</span> Star is your authoring sandbox — where you describe changes and see them live. (Later, each of your app's tenants/users gets their own Star.)</p>
            </div>
          </div>
          <p v-if="!connected" class="opacity-80">Claim your Universe on the left to get started.</p>
          <p v-else class="opacity-80">Next: open <span class="font-medium">Manage my scopes</span> (top right) to add a Galaxy, then a Star — then open the Star to start building.</p>
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
            <p v-if="deletePlan.blockedBy.length" class="text-sm text-error">
              Blocked — other users are attached to {{ deletePlan.blockedBy.map((b) => `${b.instanceName} (${b.email})`).join(", ") }}.
            </p>
            <p v-else class="text-sm text-success">No other users — safe to wipe.</p>
            <div class="flex gap-2">
              <button class="btn btn-sm" :disabled="busy" @click="cancelDelete">Cancel</button>
              <button class="btn btn-sm btn-error" :disabled="busy || deletePlan.blockedBy.length > 0" @click="confirmDelete">
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
            <template v-for="s in scopes" :key="s.instanceName">
              <div class="flex items-center gap-2 border border-base-300 rounded-box p-2.5" :style="{ marginLeft: depth(s) * 20 + 'px' }">
                <span class="font-mono text-sm flex-1 truncate">{{ s.instanceName }}</span>
                <span class="text-xs opacity-40">{{ s.tier }}</span>

                <button v-if="s.isDev" class="btn btn-xs btn-primary" :disabled="busy" @click="openStar(s.instanceName)">
                  <FolderOpen class="size-3.5" /> Open
                </button>
                <button v-else-if="s.tier === 'universe'" class="btn btn-xs btn-ghost" :disabled="busy" @click="addChildFor = addChildFor === s.instanceName ? null : s.instanceName">
                  <Plus class="size-3.5" /> Galaxy
                </button>
                <button v-else-if="s.tier === 'galaxy' && !hasDevStar(s.instanceName)" class="btn btn-xs btn-ghost" :disabled="busy" @click="addStar(s.instanceName)">
                  <Plus class="size-3.5" /> Star
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
