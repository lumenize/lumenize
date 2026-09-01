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
import { canAccept } from './home-logic';

const props = defineProps<{
  flavor: 'invite' | 'self';
  scope: string;
  invitedByName?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{ accept: []; decline: [] }>();

const checked = ref(false);
const enabled = computed(() => canAccept(checked.value) && !props.busy);
</script>

<template>
  <div class="modal modal-open" role="dialog" aria-modal="true">
    <div class="modal-box">
      <h3 class="font-bold text-lg">
        {{ flavor === 'invite' ? 'You were invited' : 'Confirm your new account' }}
      </h3>

      <div v-if="flavor === 'invite'" class="py-3 space-y-2">
        <p>
          <span class="font-medium">{{ invitedByName || 'Someone' }}</span>
          <span class="text-base-content/70"> (name provided by the sender)</span>
          invited you to
          <span class="font-mono">{{ scope }}</span>.
        </p>
      </div>

      <div v-else class="py-3 space-y-2">
        <p class="font-medium">Only accept if you initiated this signup.</p>
        <p class="text-base-content/70 text-sm" data-testid="data-use-notice">
          We collect usage data to improve the product.
        </p>
      </div>

      <label class="label cursor-pointer justify-start gap-3 py-2">
        <input v-model="checked" type="checkbox" class="checkbox" data-testid="consent-checkbox" />
        <span class="label-text">
          {{ flavor === 'invite' ? 'I want to join this account' : 'I started this signup' }}
        </span>
      </label>

      <div class="modal-action">
        <button class="btn btn-ghost" :disabled="busy" @click="emit('decline')">Not now</button>
        <button
          class="btn btn-primary"
          data-testid="consent-accept"
          :disabled="!enabled"
          @click="emit('accept')"
        >
          {{ busy ? 'Accepting…' : 'Accept' }}
        </button>
      </div>
    </div>
  </div>
</template>
