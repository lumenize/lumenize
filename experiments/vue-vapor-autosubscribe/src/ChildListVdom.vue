<script setup lang="ts">
import { ids } from './holder';
import TitleVdom from './TitleVdom.vue';
</script>

<template>
  <ul>
    <TitleVdom v-for="id in ids" :key="id" :rid="id" />
  </ul>
</template>
