<script setup lang="ts">
/**
 * The page every emailed link opens, `/auth/magic-link?token=…` on the platform host.
 *
 * Loading it changes nothing: it reads the link through `POST /auth/magic-link/lookup`, which writes
 * no state, and drops the token from the address bar at once. Only this page's own `POST` consumes
 * the link — so a mail scanner fetching it, an `<img>` loading it, or a redirector sending the tab
 * here signs nobody in. For a link that opens a pending membership, an invite or a claim, the page is
 * that membership's consent screen and its Accept signs in and accepts in one click; a plain login
 * link shows "Continue as {address}". Either way the answer names where to go next, and the page
 * goes there once that host answers (`HostWait`): accepting a claim orders its first app's
 * certificate, so the count-up runs here while it is issued.
 */
import { onMounted, ref } from 'vue';
import { viewState, forgetQuery, leaveTo } from '../view-state';
import ConsentModal from './ConsentModal.vue';
import HostWait from '../HostWait.vue';

interface Lookup {
  email: string;
  spent: boolean;
  pending?: { scope: string; invited: boolean; invitedByName?: string };
  nickname?: string;
  name?: string;
}

const token = new URLSearchParams(viewState.value.search).get('token') ?? '';
const lookup = ref<Lookup | undefined>();
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const invalid = ref(false);
/** Where the answer sent this page, entered once its host answers. */
const waitingFor = ref<string | undefined>();

/** Read and discard a body — see HomeScreen's `drain` for why. */
const drain = (resp: Response) => resp.text().catch(() => { /* nothing to drain is fine */ });

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The page's one consuming request: Continue, or Accept with the names the consent screen took. */
async function consume(names: { nickname?: string; name?: string } = {}) {
  busy.value = true;
  error.value = '';
  let leaving = false;
  try {
    const resp = await post('/auth/magic-link', { token, ...names });
    const body = await resp.json().catch(() => ({})) as { redirect?: string; error?: string; error_description?: string };
    if (resp.ok && body.redirect) { leaving = true; waitingFor.value = body.redirect; return; }
    if (body.error === 'link_used') { lookup.value = lookup.value ? { ...lookup.value, spent: true } : undefined; return; }
    error.value = body.error_description ?? 'Something went wrong. Try again.';
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    // A page on its way out stays busy, so Accept cannot be clicked again while the host is awaited.
    if (!leaving) busy.value = false;
  }
}

onMounted(async () => {
  // The token leaves the address bar before anything else, so neither history nor a shared screen
  // carries it.
  forgetQuery(['token']);
  try {
    if (!token) { invalid.value = true; return; }
    const resp = await post('/auth/magic-link/lookup', { token });
    if (!resp.ok) { await drain(resp); invalid.value = true; return; }
    lookup.value = await resp.json() as Lookup;
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="w-full max-w-md mx-auto">
    <HostWait v-if="waitingFor" :url="waitingFor" />

    <p v-if="loading" class="text-center text-base-content/70">Loading…</p>

    <div v-else-if="invalid" class="card bg-base-200" data-testid="link-invalid">
      <div class="card-body items-center text-center">
        <p>This link is invalid or has expired.</p>
        <a class="btn btn-primary btn-sm" href="/auth/login">Sign in</a>
      </div>
    </div>

    <div v-else-if="lookup?.spent" class="card bg-base-200" data-testid="link-used">
      <div class="card-body items-center text-center">
        <p>This link was already used. Sign in again for a new one.</p>
        <a class="btn btn-primary btn-sm" href="/auth/login">Sign in</a>
      </div>
    </div>

    <div v-else-if="lookup && !lookup.pending" class="card bg-base-200">
      <div class="card-body items-center text-center">
        <button class="btn btn-primary" :disabled="busy" data-testid="link-continue" @click="consume()">
          Continue as {{ lookup.email }}
        </button>
        <p v-if="error" class="text-error text-sm" data-testid="link-error">{{ error }}</p>
      </div>
    </div>

    <template v-else-if="lookup?.pending">
      <p v-if="error" class="alert alert-error text-sm mb-4" data-testid="link-error">{{ error }}</p>
      <ConsentModal
        :flavor="lookup.pending.invited ? 'invite' : 'self'"
        :scope="lookup.pending.scope"
        :invited-by-name="lookup.pending.invitedByName"
        :nickname="lookup.nickname"
        :name="lookup.name"
        :busy="busy"
        @accept="consume"
        @decline="leaveTo('/')"
      />
    </template>

    <p v-else-if="error" class="text-error text-sm text-center">{{ error }}</p>
  </div>
</template>
