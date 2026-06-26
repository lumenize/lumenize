<script setup lang="ts">
import { ref, shallowRef, onMounted } from "vue";
import { Send, RotateCcw, LogIn, Loader2 } from "lucide-vue-next";
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
// scope (localStorage), else it's resolved from discovery when you log in. The `test-` prefix is
// the reaper's auto-reap marker (single hyphen — nebula-auth's parse-id rejects consecutive ones).
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

    <!-- Preview pane -->
    <section class="flex-1 bg-base-100">
      <iframe :src="previewSrc" class="w-full h-full border-0" title="Preview" />
    </section>
  </div>
</template>
