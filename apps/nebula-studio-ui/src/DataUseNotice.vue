<script setup lang="ts">
/**
 * The data-use notice — one component, rendered at both placements.
 *
 * It appears where a person COMMITS to something: the self-signup consent modal (directly under
 * "Only accept if you initiated this signup"), and Studio's create-App flow. Not on a login page —
 * an Account or App owner owns their own tenants' data relationship, and a per-tenant notice is
 * theirs to write, not ours to impose.
 *
 * ⚠️ **Informational, and it stores nothing.** There is no checkbox here and no recorded consent:
 * the modal's checkbox acknowledges the "only accept if" warning above it, and nothing about this
 * notice is written anywhere. Adding a recorded consent would be schema and ceremony for something
 * that gates nothing — the time to build it is when a customer requires it.
 *
 * ⚠️ **The wording is generic on purpose** — it names Lumenize, never Studio and never the model
 * behind it, so it stays true as the product changes underneath it.
 */
</script>

<template>
  <p class="text-sm opacity-70" data-testid="data-use-notice">
    Your data will only be used to maintain and improve Lumenize.
  </p>
</template>
