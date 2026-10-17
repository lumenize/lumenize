<script setup lang="ts">
import { holder } from './holder';
import { probe } from './probe';
defineProps<{ rid: string }>();
const store = holder.store;
</script>

<template>
  <li class="item">{{ probe('child') }}{{ store.resources.TestResource[rid]?.value?.title ?? '?' }}</li>
</template>
