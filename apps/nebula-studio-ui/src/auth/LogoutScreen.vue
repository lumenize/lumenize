<script setup lang="ts">
/**
 * The logout page on the platform host — where every "Log out" arrives.
 *
 * It says what is about to end before anything does: every session this browser holds, on every
 * host, and with "on every device" chosen, every session of the addresses those sessions belong to.
 * Nothing ends on load, so a page that sends the tab here causes nothing; the button posts the one
 * logout route, which is same-origin here.
 */
import { ref } from 'vue';
import { viewState, leaveTo } from '../view-state';

const everywhere = ref(new URLSearchParams(viewState.value.search).has('everywhere'));
const busy = ref(false);
const error = ref('');

async function logout() {
  busy.value = true;
  error.value = '';
  try {
    const resp = await fetch('/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ everywhere: everywhere.value }),
    });
    await resp.text().catch(() => { /* drained, see HomeScreen */ });
    if (!resp.ok) { error.value = 'Could not log you out. Try again.'; return; }
    leaveTo('/auth/login');
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card bg-base-200 w-full max-w-md mx-auto">
    <div class="card-body space-y-3">
      <h1 class="card-title">Log out</h1>
      <p>This ends every Lumenize session in this browser, on every app and account.</p>
      <label class="label cursor-pointer justify-start gap-3">
        <input v-model="everywhere" type="checkbox" class="checkbox" data-testid="logout-everywhere" />
        <span>Also end my sessions on every other device</span>
      </label>
      <button class="btn btn-primary" :disabled="busy" data-testid="logout-confirm" @click="logout">
        {{ busy ? 'Logging out…' : 'Log out' }}
      </button>
      <p v-if="error" class="text-error text-sm">{{ error }}</p>
    </div>
  </div>
</template>
