<script setup lang="ts">
import { ref, shallowRef, onMounted } from "vue";
import { Send, RotateCcw, LogIn, Loader2 } from "lucide-vue-next";
import { createNebulaClient } from "@lumenize/nebula/frontend";
// Type-only (erased at build — does NOT pull cloudflare:workers into the browser bundle).
import type { DevStudio, Star } from "@lumenize/nebula";

// --- Dev config (first cut) ---------------------------------------------------------
// Dev sandbox scope + bootstrap email. DEV_EMAIL MUST match
// NEBULA_AUTH_BOOTSTRAP_EMAIL in your gitignored root .dev.vars (with
// NEBULA_AUTH_TEST_MODE=true) — see README.md.
//
// The scope is the {u}.{g}.dev instance shared by DevStudio / DevContainer / the dev
// Star. It is configurable via the `?scope=` query param so the Playwright UI smoke can
// drive a dedicated `test-u0.test-g0.dev` sandbox (the `test-` prefix is the reaper's
// auto-reap marker — SINGLE hyphen: nebula-auth's parse-id rejects consecutive hyphens)
// without colliding with a manual session; manual dev defaults to `acme.app.dev`. Must be
// a valid `{u}.{g}.dev` instance (server-validated on first call).
const DEV_SCOPE = new URLSearchParams(location.search).get("scope") ?? "acme.app.dev";
// Must have a TLD (auth validates /^[^\s@]+@[^\s@]+\.[^\s@]+$/) AND match
// NEBULA_AUTH_BOOTSTRAP_EMAIL in your .dev.vars.
const DEV_EMAIL = "dev@example.com";

type Msg = { role: "you" | "studio" | "error" | "thought"; text: string };
const messages = ref<Msg[]>([]);
const input = ref("");
const connected = ref(false);
const busy = ref(false);
const thinking = ref(false); // model is generating — shows the "Studio is thinking…" indicator
const previewSrc = ref(`/dev-container/${DEV_SCOPE}/`);
const nebula = shallowRef<ReturnType<typeof createNebulaClient> | null>(null);

const log = (role: Msg["role"], text: string) => messages.value.push({ role, text });

/** Force the preview iframe to re-fetch (HMR-under-prefix is deferred, so a source
 *  change needs a reload to show). */
function reloadPreview() {
  previewSrc.value = `/dev-container/${DEV_SCOPE}/?t=${Date.now()}`;
}

/** Dev-only login: NEBULA_AUTH_TEST_MODE=true makes the magic-link endpoint return the
 *  link in the response (`?_test=true`) instead of emailing it; the bootstrap email is
 *  promoted to admin. Same-origin via the vite proxy so the refresh cookie lands here. */
async function devLogin() {
  busy.value = true;
  try {
    const res = await fetch(`/auth/${DEV_SCOPE}/email-magic-link?_test=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email: DEV_EMAIL }),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw new Error(`magic-link ${res.status}: ${JSON.stringify(body)}`);
    // Test-mode response key is `magic_link` (snake_case); a few fallbacks just in case.
    const link: string | undefined = body.magic_link ?? body.links?.[0] ?? body.link ?? body.magicLink;
    if (!link) throw new Error(`no magic link in response (is NEBULA_AUTH_TEST_MODE=true?) — ${JSON.stringify(body)}`);
    // Follow same-origin (path+query only) so the refresh cookie is set on this origin.
    const u = new URL(link, location.origin);
    await fetch(u.pathname + u.search, { credentials: "include", redirect: "manual" }).catch(() => {});
    await connect();
  } catch (e) {
    log("error", `Login failed: ${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}

async function connect() {
  const n = createNebulaClient({
    authScope: DEV_SCOPE,
    activeScope: DEV_SCOPE,
    appVersion: "studio-ui", // the Studio UI calls DevStudio, not the ontology — never version-checked
  });
  await n.ready; // throws if not authenticated (no / expired refresh cookie)
  nebula.value = n; // only adopt the client once the session is live
  connected.value = true;
  log("studio", "Connected. Describe the app you want to build.");
}

// Auto-connect when a valid refresh cookie is already present — a returning session,
// or the UI smoke that logs in out-of-band (real magic-link) then loads the Studio.
// Falls back to the "Log in (dev)" button when not yet authenticated.
onMounted(() => {
  connect().catch(() => {
    /* not authenticated — show the login button */
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
      DEV_SCOPE,
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
    await client.lmz.callRaw("STAR", DEV_SCOPE, client.ctn<Star>().resetDevData());
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
        <button v-if="!connected" class="btn btn-primary w-full" :disabled="busy" @click="devLogin">
          <Loader2 v-if="busy" class="size-4 animate-spin" />
          <LogIn v-else class="size-4" />
          Log in (dev)
        </button>
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
