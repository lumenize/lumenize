<script setup vapor lang="ts">
import { ids } from './holder';
import TitleVapor from './TitleVapor.vue';
</script>

<template>
  <ul>
    <TitleVapor v-for="id in ids" :key="id" :rid="id" />
  </ul>
</template>
