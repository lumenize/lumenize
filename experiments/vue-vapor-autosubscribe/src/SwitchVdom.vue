<script setup lang="ts">
import { holder, current, tick } from './holder';
import { probe } from './probe';
const store = holder.store;
</script>

<template>
  <span class="title">{{ probe('switch') }}{{ store.resources.TestResource[current]?.value?.title ?? 'pending' }}</span>
  <span class="tick">{{ tick }}</span>
</template>
