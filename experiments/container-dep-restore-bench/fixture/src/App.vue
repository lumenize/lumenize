<script setup lang="ts">
// Build fixture — deliberately heavier than the real seed App.vue so `vite build`
// does representative work: several lucide icons (that 33 MB icon package is the
// single largest thing in the tree, so icon resolution is the realistic hot path)
// plus daisyui component classes so tailwind's oxide scanner has real markup to walk.
import {
  House, Search, Settings, User, Bell, ChartBar, Table, Calendar,
} from 'lucide-vue-next';
import { ref, computed } from 'vue';

const rows = ref([
  { id: 1, name: 'Alpha', status: 'active', n: 42 },
  { id: 2, name: 'Beta', status: 'paused', n: 17 },
  { id: 3, name: 'Gamma', status: 'active', n: 93 },
]);
const q = ref('');
const shown = computed(() =>
  rows.value.filter((r) => r.name.toLowerCase().includes(q.value.toLowerCase())),
);
const total = computed(() => shown.value.reduce((s, r) => s + r.n, 0));
</script>

<template>
  <div class="min-h-screen bg-base-200">
    <div class="navbar bg-base-100 shadow-sm">
      <div class="flex-1 flex items-center gap-2 px-4">
        <House class="size-5 text-primary" />
        <span class="text-lg font-bold">Dep-restore bench fixture</span>
      </div>
      <div class="flex-none flex gap-2 px-4">
        <Bell class="size-5" />
        <Settings class="size-5" />
        <User class="size-5" />
      </div>
    </div>

    <main class="mx-auto max-w-3xl p-8 flex flex-col gap-6">
      <label class="input input-bordered flex items-center gap-2">
        <Search class="size-4 opacity-60" />
        <input v-model="q" type="text" class="grow" placeholder="Filter rows" />
      </label>

      <div class="stats shadow">
        <div class="stat">
          <div class="stat-figure text-primary"><ChartBar class="size-8" /></div>
          <div class="stat-title">Total</div>
          <div class="stat-value">{{ total }}</div>
        </div>
        <div class="stat">
          <div class="stat-figure text-secondary"><Calendar class="size-8" /></div>
          <div class="stat-title">Rows</div>
          <div class="stat-value">{{ shown.length }}</div>
        </div>
      </div>

      <div class="card bg-base-100 shadow">
        <div class="card-body">
          <h2 class="card-title flex items-center gap-2"><Table class="size-5" /> Rows</h2>
          <table class="table">
            <thead><tr><th>Name</th><th>Status</th><th class="text-right">N</th></tr></thead>
            <tbody>
              <tr v-for="r in shown" :key="r.id">
                <td class="font-medium">{{ r.name }}</td>
                <td>
                  <span class="badge" :class="r.status === 'active' ? 'badge-success' : 'badge-ghost'">
                    {{ r.status }}
                  </span>
                </td>
                <td class="text-right tabular-nums">{{ r.n }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
</template>
