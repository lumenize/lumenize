<script setup lang="ts">
// Imports every heavy library for real, so rolldown bundles them rather than tree-shaking
// the whole import away.
import { onMounted, ref } from "vue";
import { Sparkles } from "lucide-vue-next";
import * as echarts from "echarts";
import { PerspectiveCamera, Scene } from "three";
import { format } from "date-fns";
import { debounce } from "lodash-es";
import { Stamper } from "./decorated";

const chart = ref<HTMLDivElement>();
const label = ref(format(new Date(0), "yyyy-MM-dd"));
const scene = new Scene();
scene.add(new PerspectiveCamera());
const relabel = debounce(() => (label.value = new Stamper().stamp()), 10);

onMounted(() => {
  echarts.init(chart.value!).setOption({ series: [{ type: "bar", data: [1, 2, 3] }] });
  relabel();
});
</script>

<template>
  <div class="p-4">
    <button class="btn btn-primary w-[347px]"><Sparkles /> {{ label }} {{ scene.children.length }}</button>
    <div ref="chart" class="h-64"></div>
  </div>
</template>
