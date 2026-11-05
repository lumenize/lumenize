<script setup vapor lang="ts">
import { holder, ids } from './holder';
import { probe } from './probe';
const store = holder.store;
</script>

<template>
  <ul>
    <li v-for="id in ids" :key="id" class="item">{{ probe('list') }}{{ store.resources.TestResource[id]?.value?.title ?? '?' }}</li>
  </ul>
</template>
