<script setup lang="ts">
import { ref } from "vue";
// Tree-shaking probe (Q3): import exactly ONE icon out of lucide's ~1700.
// The in-DO approach ships a shared core + per-icon files because it can't tree-shake;
// vite should pull in only this icon's data.
import { House } from "lucide-vue-next";

const marker = ref("v0");
const count = ref(0);
</script>

<template>
  <!-- Tailwind JIT probes (Q3): an ARBITRARY value (w-[347px]) the in-DO DaisyUI-only
       path can't emit, plus responsive (md:) + state (hover:) variants. -->
  <main class="mx-auto w-[347px] p-6 flex flex-col gap-4 font-sans md:bg-slate-50">
    <h1 class="text-2xl font-bold flex items-center gap-2">
      <House class="size-6 text-sky-600" /> Container + vite — marker {{ marker }}
    </h1>
    <button
      class="px-4 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 transition-colors"
      @click="count++"
    >
      count is {{ count }}
    </button>
    <p class="text-sm text-slate-500">
      Tailwind JIT emits only the utilities used here (incl. the arbitrary
      <code>w-[347px]</code>); Lucide ships only <code>House</code>. That's the
      minimal-CSS + tree-shaking win the in-DO path can't do.
    </p>
  </main>
</template>
