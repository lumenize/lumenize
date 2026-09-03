<script setup lang="ts">
/**
 * The front door. One address in, one link out — and nothing is revealed before the click.
 *
 * ⚠️ **The response is uniform for every address**, member and stranger alike. That is the point of
 * the whole prove-then-choose design: the old form asked the server which scopes an address belonged
 * to *before* anyone proved anything, which answered a question no unauthenticated caller should be
 * able to ask. There is deliberately nothing here that branches on who the address turns out to be.
 *
 * The "create an account" affordance is the declared-newbie path: it names the account up front and
 * sends the claim link, so a new user spends one email instead of two. Someone who does not declare
 * themselves gets the same single email and lands on the slug screen instead.
 */
import { ref } from 'vue';

const email = ref('');
const accountName = ref('');
const creating = ref(false);
const busy = ref(false);
const sent = ref(false);
const error = ref('');

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const resp = creating.value
      // The name IS the account id — nothing is derived from it, so what the user typed is what
      // they get, and a second attempt with the same name resumes rather than colliding.
      ? await post('/auth/claim-universe', { slug: accountName.value.trim(), email: email.value.trim() })
      : await post('/auth/email-magic-link', { email: email.value.trim() });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error_description?: string };
      error.value = body.error_description ?? 'Something went wrong. Try again.';
      return;
    }
    sent.value = true;
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
      <h1 class="card-title">Sign in to Nebula</h1>

      <div v-if="sent" class="space-y-2">
        <p>Check your email — we sent a link to <span class="font-medium">{{ email }}</span>.</p>
        <p class="text-base-content/70 text-sm">The link works for about half an hour.</p>
      </div>

      <form v-else class="space-y-3" @submit.prevent="submit">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Email</legend>
          <input
            v-model="email" type="email" required autocomplete="email"
            class="input w-full" placeholder="you@example.com"
          />
        </fieldset>

        <fieldset v-if="creating" class="fieldset">
          <legend class="fieldset-legend">Name your account</legend>
          <input
            v-model="accountName" type="text" required
            class="input w-full" placeholder="acme"
          />
          <p class="label">Lowercase letters, numbers and hyphens.</p>
        </fieldset>

        <button class="btn btn-primary w-full" type="submit" :disabled="busy">
          {{ busy ? 'Sending…' : creating ? 'Create account' : 'Email me a link' }}
        </button>

        <p v-if="error" class="text-error text-sm">{{ error }}</p>

        <button type="button" class="btn btn-ghost btn-sm w-full" @click="creating = !creating">
          {{ creating ? 'I already have an account' : 'Create a new account' }}
        </button>
      </form>
    </div>
  </div>
</template>
