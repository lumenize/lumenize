<script setup lang="ts">
/**
 * The fallback slug screen: someone proved their address and turned out to have nowhere to go.
 *
 * ⚠️ **No email field, deliberately.** The address is carried by the signup-ticket cookie the click
 * just set, and the server reads it from there — a field here would be both a lie (typing a
 * different address would change nothing) and an invitation to try. The only thing this screen
 * collects is the name.
 *
 * ⚠️ **No second email is sent.** The claim spends the ticket and logs the person straight in, which
 * is the whole reason the ticket exists: the mailbox was proved seconds ago by the click that landed
 * them here.
 */
import { ref } from 'vue';

const accountName = ref('');
const busy = ref(false);
const error = ref('');

async function claim() {
  error.value = '';
  busy.value = true;
  try {
    const resp = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: accountName.value.trim() }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error_description?: string };
      error.value = body.error_description ?? 'Something went wrong. Try again.';
      return;
    }
    // The response names where to go, rather than this screen rebuilding the path — the server
    // already decided which scope was claimed, and it is the one that knows.
    const { home } = await resp.json() as { home: string };
    window.location.assign(home);
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card bg-base-200 w-full max-w-md mx-auto">
    <div class="card-body">
      <h1 class="card-title">Name your account</h1>
      <p class="text-base-content/70">
        Your email is confirmed. Pick a name and you're in — no second email.
      </p>

      <form class="space-y-3" @submit.prevent="claim">
        <label class="form-control w-full">
          <input
            v-model="accountName" type="text" required autofocus
            class="input input-bordered w-full" placeholder="acme"
          />
          <span class="label-text-alt text-base-content/60">
            Lowercase letters, numbers and hyphens.
          </span>
        </label>

        <button class="btn btn-primary w-full" type="submit" :disabled="busy">
          {{ busy ? 'Creating…' : 'Create account' }}
        </button>

        <p v-if="error" class="text-error text-sm">{{ error }}</p>
      </form>
    </div>
  </div>
</template>
