<script setup lang="ts">
/**
 * The consent modal — two flavors, one control pattern.
 *
 * Every membership in Nebula is taken up here and nowhere else. A click on a link proves an address;
 * it does not agree to anything, so the cookie it places is inert until this modal's Accept fires.
 *
 * ⚠️ **The two flavors say materially different things**, which is why the flavor is computed by a
 * named function and passed in rather than inferred from whatever fields happen to be present:
 *
 *  - **invite** — someone else put this membership here, so it names them. The name is whatever the
 *    inviter typed, so it is attributed as their claim rather than presented as verified fact.
 *  - **self** — nobody else was involved, so the risk is the opposite one: a person who did NOT
 *    start this should stop. That warning comes first, and the data-use notice follows it.
 *
 * ⚠️ **Accept is disabled until the box is checked**, in both flavors. The checkbox is what makes
 * this a decision rather than a dialog someone dismisses.
 */
import { ref, computed } from 'vue';
import { UserRound } from 'lucide-vue-next';
import { canAccept } from './home-logic';
import DataUseNotice from '../DataUseNotice.vue';

const props = defineProps<{
  flavor: 'invite' | 'self';
  scope: string;
  invitedByName?: string;
  /** The names already on file, if any — pre-filled so a second acceptance neither re-asks nor
   *  silently replaces what this person chose the first time. */
  nickname?: string;
  name?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{ accept: [names: { nickname: string; name?: string }]; decline: [] }>();

const checked = ref(false);
const nick = ref(props.nickname ?? '');
const fullName = ref(props.name ?? '');
const enabled = computed(() => canAccept(checked.value, nick.value) && !props.busy);

/** Omit an empty full name rather than sending `''` — absent means "not offered", and the server
 *  writes `name` only when supplied so a later acceptance cannot blank one already set. */
function submitAccept() {
  const trimmed = fullName.value.trim();
  emit('accept', { nickname: nick.value.trim(), ...(trimmed ? { name: trimmed } : {}) });
}
</script>

<template>
  <div class="modal modal-open" role="dialog" aria-modal="true">
    <div class="modal-box">
      <h3 class="font-bold text-lg">
        {{ flavor === 'invite' ? 'You were invited' : 'Confirm your new account' }}
      </h3>

      <div v-if="flavor === 'invite'" class="py-3 space-y-2">
        <!-- ⚠️ The name is attributed to the SENDER in the sentence itself, not merely rendered.
             The adversary this modal defends against is the person who typed it — an unattributed
             free-text name presented as the consent's only identity is a phishing surface
             ("IT Security"). The target, which the inviter cannot choose, sits beside it. -->
        <p>
          <span class="font-medium">{{ invitedByName || 'Someone' }}</span>
          <span class="text-base-content/70">(supplied by the sender)</span>
          invited you to collaborate in
          <span class="font-mono">{{ scope }}</span>.
        </p>
      </div>

      <div v-else class="py-3 space-y-2">
        <p class="font-medium">Only accept if you initiated this signup.</p>
        <DataUseNotice />
      </div>

      <!-- ⚠️ Asked HERE, once. This is the last moment before the person reaches a surface where
           other people can see them, and it is the only place every arrival passes through — which
           is why no app surface needs a blocking name modal of its own. -->
      <div class="flex items-start gap-4 py-2">
        <!-- A placeholder, not an uploader: there is NO session yet (the cookie is inert until Accept),
             so nothing on this screen could be authorized to store a picture. The editor behind the
             avatar menu is where that happens, once they are in. -->
        <div class="flex flex-col items-center gap-1 shrink-0 w-24 text-center" data-testid="consent-avatar">
          <span class="size-14 rounded-full bg-neutral text-neutral-content grid place-items-center">
            <UserRound class="size-8" />
          </span>
          <span class="text-xs opacity-60">Add a picture from your profile once you're in.</span>
        </div>

        <div class="flex-1 space-y-2">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Nickname</legend>
            <input
              v-model="nick"
              type="text"
              required
              class="input w-full"
              placeholder="Robin"
              data-testid="consent-nickname"
            />
          </fieldset>

          <fieldset class="fieldset">
            <legend class="fieldset-legend">Full name <span class="opacity-60">(optional)</span></legend>
            <input
              v-model="fullName"
              type="text"
              class="input w-full"
              placeholder="Robin Fielding"
              data-testid="consent-name"
            />
          </fieldset>
        </div>
      </div>

      <label class="label cursor-pointer justify-start gap-3 py-2">
        <input v-model="checked" type="checkbox" class="checkbox" data-testid="consent-checkbox" />
        <span>
          {{ flavor === 'invite' ? 'I want to join this account' : 'I started this signup' }}
        </span>
      </label>

      <div class="modal-action">
        <button class="btn btn-ghost" :disabled="busy" @click="emit('decline')">Not now</button>
        <button
          class="btn btn-primary"
          data-testid="consent-accept"
          :disabled="!enabled"
          @click="submitAccept"
        >
          {{ busy ? 'Accepting…' : 'Accept' }}
        </button>
      </div>
    </div>

  </div>
</template>
