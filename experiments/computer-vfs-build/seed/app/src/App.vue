<script setup lang="ts">
// Seed App.vue — a standalone boot placeholder so vite serves a shell BEFORE the
// first DevStudio push (Flow 1c) and the image self-validates vite+HMR without the
// frontend factory. DevStudio's first `applyChanges` OVERWRITES this with the
// generated app, which imports `{ client, store }` from ./nebula.ts.
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
