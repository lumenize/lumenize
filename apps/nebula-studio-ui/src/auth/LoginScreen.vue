<script setup lang="ts">
/**
 * The front door. One address in, one link out — and nothing is revealed before the click.
 *
 * ⚠️ **The response is uniform for every address**, member and stranger alike. That is the point of
 * the whole prove-then-choose design: the old form asked the server which scopes an address belonged
 * to *before* anyone proved anything, which answered a question no unauthenticated caller should be
 * able to ask. There is deliberately nothing here that branches on who the address turns out to be.
 *
 * The "create an account" affordance is the declared-newbie path: it names the account and its
 * first app up front and sends the claim link, so a new user spends one email instead of two, and the
 * claim writes the app they came to build. Someone who does not declare themselves gets the same
 * single email and lands on the signup page instead.
 *
 * **`return_to` is passed along, never trusted here.** A page sent here by a missing session names
 * itself in `return_to`; this page hands it to `email-magic-link`, which checks it against the
 * deployment's hosts before storing it with the link, and the link's consume sends the person back.
 *
 * **A pending membership is offered before a login form.** Someone who signed in through a plain
 * link without accepting an invite holds that membership's cookie; visiting the invite's host fails
 * its refresh and lands them here. This page asks Home's summary which pending cookies the browser
 * holds and, when one is the membership at the host `return_to` names, offers its consent instead.
 */
import { onMounted, ref } from 'vue';
import { viewState, leaveTo } from '../view-state';
import { parseHost, deploymentOriginOfPage } from '@lumenize/mesh/client';
import ConsentModal from './ConsentModal.vue';
import { pendingFor } from './home-logic';

const returnTo = new URLSearchParams(viewState.value.search).get('return_to') ?? undefined;

/** The scope the page `return_to` names lives at, if it names a scope's host. */
function returnScope(): string | undefined {
  const deployment = deploymentOriginOfPage();
  if (!returnTo || !deployment) return undefined;
  try {
    const target = parseHost(new URL(returnTo).host, deployment);
    return target?.kind === 'scope' ? target.scope : undefined;
  } catch {
    return undefined;
  }
}

/** The pending membership to consent to instead of a login form, with its card. */
const consent = ref<{ scope: string; invited: boolean; invitedByName?: string; nickname?: string; name?: string } | undefined>();
const accepting = ref(false);

onMounted(async () => {
  const scope = returnScope();
  if (!scope) return;
  try {
    const home = await fetch('/auth/home-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!home.ok) { await home.text().catch(() => {}); return; }
    const { pending } = await home.json() as { pending: string[] };
    const target = pendingFor(pending, scope);
    if (!target) return;
    const card = await fetch('/auth/pending-membership', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: target }),
    });
    if (!card.ok) { await card.text().catch(() => {}); return; }
    const c = await card.json() as { invited?: boolean; invitedByName?: string; nickname?: string; name?: string };
    consent.value = { scope: target, invited: c.invited === true, invitedByName: c.invitedByName, nickname: c.nickname, name: c.name };
  } catch { /* the login form is the fallback */ }
});

async function acceptPending(names: { nickname: string; name?: string }) {
  if (!consent.value) return;
  accepting.value = true;
  try {
    const resp = await fetch('/auth/accept-membership', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: consent.value.scope, ...names }),
    });
    const body = await resp.json().catch(() => ({})) as { error_description?: string };
    if (!resp.ok) { error.value = body.error_description ?? 'Could not accept that. Try again.'; consent.value = undefined; return; }
    leaveTo(returnTo!);
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    accepting.value = false;
  }
}

const email = ref('');
const accountName = ref('');
const appName = ref('');
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
      // Each name IS its id — nothing is derived from it, so what the user typed is what they get,
      // and a second attempt with the same account name resumes rather than colliding.
      ? await post('/auth/claim-universe', {
        slug: accountName.value.trim(), appSlug: appName.value.trim(), email: email.value.trim(),
      })
      : await post('/auth/email-magic-link', { email: email.value.trim(), ...(returnTo ? { return_to: returnTo } : {}) });

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
      <h1 class="card-title">Sign in to Lumenize</h1>

      <div v-if="sent" class="space-y-2">
        <p>Check your email — we sent a link to <span class="font-medium">{{ email }}</span>.</p>
        <p class="text-base-content/70 text-sm">The link works for about half an hour.</p>
      </div>

      <ConsentModal
        v-else-if="consent"
        :flavor="consent.invited ? 'invite' : 'self'"
        :scope="consent.scope"
        :invited-by-name="consent.invitedByName"
        :nickname="consent.nickname"
        :name="consent.name"
        :busy="accepting"
        @accept="acceptPending"
        @decline="consent = undefined"
      />

      <form v-else class="space-y-3" @submit.prevent="submit">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Email</legend>
          <input
            v-model="email" type="email" required autocomplete="email"
            class="input w-full" placeholder="you@example.com"
          />
        </fieldset>

        <template v-if="creating">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Account</legend>
            <input
              v-model="accountName" type="text" required
              class="input w-full" placeholder="acme"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Your first app</legend>
            <input
              v-model="appName" type="text" required
              class="input w-full" placeholder="crm"
            />
            <p class="label">Lowercase letters, numbers and hyphens.</p>
          </fieldset>
        </template>

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
