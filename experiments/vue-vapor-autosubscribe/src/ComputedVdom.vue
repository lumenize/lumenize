<script setup lang="ts">
import { computed } from 'vue';
import { holder, current, tick } from './holder';
import { probe } from './probe';
const store = holder.store;
const title = computed(() => {
  probe('computed:' + current.value.slice(0, 8));
  return store.resources.TestResource[current.value]?.value?.title ?? 'pending';
});
</script>

<template>
  <span class="title">{{ title }}</span>
  <span class="tick">{{ tick }}</span>
</template>
