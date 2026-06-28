<template>
  <div class="map-view">
    <MapHeader />
    <div class="map-body">
      <MapContainer />
    </div>
    <TimelinePanel v-if="ui.panelOpen" />
  </div>
</template>

<script setup lang="ts">
import MapHeader from "./MapHeader.vue";
import MapContainer from "./MapContainer.vue";
import TimelinePanel from "../timeline/TimelinePanel.vue";
import { useUIStore } from "../../stores/ui";

const ui = useUIStore();
</script>

<style lang="scss" scoped>
.map-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.map-body {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
