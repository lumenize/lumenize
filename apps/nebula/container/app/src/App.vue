<script setup lang="ts">
// Seed App.vue — a standalone boot placeholder so the first build serves a shell
// BEFORE any codegen turn. The loop's first write_file OVERWRITES this with the
// generated app.
import { House } from 'lucide-vue-next';
</script>

<template>
  <main class="mx-auto max-w-xl p-8 flex flex-col gap-4 items-center text-center">
    <House class="size-10 text-primary" />
    <h1 class="text-2xl font-bold">Your app is warming up…</h1>
    <p class="text-base-content/70">
      Describe what you want to build in the chat and your app will appear here.
    </p>
  </main>
</template>
