<script setup lang="ts">
/**
 * Home — where a proved address chooses what to enter, and consents to each membership.
 *
 * ⚠️ **PLACEHOLDER — the shell only.** Phase 6 built the SPA that serves this route; the screen
 * itself (the email strip, the tree with its ≤20 rules and badges, and the two consent-modal
 * flavors) is Phase 7 of `tasks/nebula-login-prove-then-choose.md`, and its acceptance criteria live
 * there. What is here renders the scope the URL names so the serving path is verifiable end to end,
 * and nothing more — in particular it fetches no summary and offers no Accept, so a membership
 * arriving here stays unaccepted and its cookie stays inert.
 */
defineProps<{ scope: string }>();
</script>

<template>
  <div class="card bg-base-200 w-full max-w-md mx-auto">
    <div class="card-body items-center text-center">
      <h1 class="card-title">Home</h1>
      <p class="text-base-content/70">Signed in at <span class="font-mono">{{ scope }}</span>.</p>
    </div>
  </div>
</template>
