<script setup lang="ts">
/**
 * The wait before entering a new app: a seconds count-up while its host's certificate is issued,
 * then the move there (`host-wait.ts` says why). Rendered by whichever page is sending the person,
 * standing on its own rather than in that page's `v-if` chain. It shows nothing until the first
 * probe misses, so a host that already answers is entered at once.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { leaveTo } from './view-state';
import { waitUntilHostAnswers } from './host-wait';

const props = defineProps<{ url: string }>();

const waiting = ref(false);
const seconds = ref(0);
/** The host awaited, read once there is a wait — only an absolute URL can have one. */
const host = ref('');
const gone = new AbortController();
let ticker: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  await waitUntilHostAnswers(props.url, {
    signal: gone.signal,
    onWaiting: () => {
      host.value = new URL(props.url).host;
      waiting.value = true;
      ticker = setInterval(() => { seconds.value++; }, 1000);
    },
  });
  if (!gone.signal.aborted) leaveTo(props.url);
});

onUnmounted(() => {
  gone.abort();
  clearInterval(ticker);
});
</script>

<template>
  <dialog v-if="waiting" class="modal" open data-testid="host-wait">
    <div class="modal-box text-center space-y-3">
      <span class="loading loading-spinner loading-md"></span>
      <p>Getting <strong>{{ host }}</strong> ready.</p>
      <p class="text-sm text-base-content/70">
        A new app's secure address takes a few minutes to set up. You'll go there as soon as it answers.
      </p>
      <p class="font-mono text-lg" data-testid="host-wait-seconds">{{ seconds }} s</p>
    </div>
  </dialog>
</template>
