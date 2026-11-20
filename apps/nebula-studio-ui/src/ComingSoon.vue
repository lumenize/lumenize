<script setup lang="ts">
/**
 * A surface that does not exist yet, and a way to say you wanted it.
 *
 * The button reports a TAG from a closed server-side set, never free text — the endpoint is
 * unauthenticated, so arbitrary strings would make it a log-injection faucet. The tag this component
 * is given must be one the server knows; an unknown one comes back 400 and is shown as a failure
 * rather than silently swallowed.
 */
import { ref } from 'vue';

const props = defineProps<{ title: string; tag: string; blurb?: string }>();

const state = ref<'idle' | 'sending' | 'sent' | 'failed'>('idle');

async function tellThem() {
  state.value = 'sending';
  try {
    const resp = await fetch('/auth/coming-soon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: props.tag }),
    });
    // ⚠️ Drain the body before settling. The endpoint answers 204, and a `fetch` whose response is
    // never read leaves the load open for Chromium to cancel — which surfaces as a
    // `net::ERR_ABORTED` on a request that plainly succeeded, and reads as a broken endpoint to
    // anything watching the network (it reddened `auth-pages-render`'s clean-requests limb).
    await resp.text().catch(() => { /* nothing to drain is fine */ });
    state.value = resp.ok ? 'sent' : 'failed';
  } catch {
    state.value = 'failed';
  }
}
</script>

<template>
  <div class="card bg-base-200 max-w-md mx-auto">
    <div class="card-body items-center text-center">
      <h2 class="card-title">{{ title }}</h2>
      <p v-if="blurb" class="text-base-content/70">{{ blurb }}</p>
      <p class="text-base-content/70">This is not built yet.</p>

      <button
        v-if="state !== 'sent'"
        class="btn btn-primary"
        :disabled="state === 'sending'"
        @click="tellThem"
      >
        {{ state === 'sending' ? 'Sending…' : 'I want this' }}
      </button>
      <p v-else class="text-success">Noted — thank you.</p>

      <p v-if="state === 'failed'" class="text-error text-sm">
        That didn't go through. Try again later.
      </p>
    </div>
  </div>
</template>
