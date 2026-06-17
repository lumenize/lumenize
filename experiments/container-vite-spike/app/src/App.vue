<script setup lang="ts">
import { ref } from "vue";

// HMR marker: bump this string + save, watch it patch in-place with no full reload (Q1 warm).
const marker = ref("v0");
const count = ref(0);
</script>

<template>
  <main style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 40rem">
    <h1>Container + vite spike — marker {{ marker }}</h1>
    <button style="padding: 0.5rem 1rem; font-size: 1rem" @click="count++">
      count is {{ count }}
    </button>
    <p>
      Edit <code>app/src/App.vue</code> (change <code>marker</code>) and save. HMR should
      patch this heading in-place <strong>without</strong> resetting the counter — that's
      the warm save→paint loop Q1 measures, proxied through the lifecycle DO (Q2).
    </p>
  </main>
</template>
