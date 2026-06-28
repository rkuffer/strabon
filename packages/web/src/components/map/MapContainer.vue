<!-- MapContainer.vue — Initialise Leaflet et orchestre les layers -->
<template>
  <div ref="mapEl" class="map-container">
    <SiteMarkers v-if="mapStore.leafletMap" />
    <HullLayer v-if="mapStore.leafletMap" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import SiteMarkers from "./SiteMarkers.vue";
import HullLayer from "./HullLayer.vue";

const mapEl = ref<HTMLDivElement>();
const mapStore = useMapStore();
const temporal = useTemporalStore();

let map: L.Map | null = null;

onMounted(() => {
  if (!mapEl.value) return;

  map = L.map(mapEl.value, {
    center: [30, 15],
    zoom: 3,
    zoomControl: true,
    // Ralentir le zoom molette pour correspondre aux boutons +/-
    // wheelPxPerZoomLevel : pixels de scroll nécessaires pour 1 niveau de zoom
    // (défaut Leaflet = 60, on monte à 120 pour diviser la vitesse par 2)
    wheelPxPerZoomLevel: 120,
    wheelDebounceTime: 80,
  });

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20,
    },
  ).addTo(map);

  mapStore.setMap(map);
  mapStore.updateFromMap(map);

  map.on("moveend zoomend", () => {
    if (map) mapStore.updateFromMap(map);
  });
});

onUnmounted(() => {
  map?.remove();
  map = null;
});
</script>

<style lang="scss" scoped>
.map-container {
  width: 100%;
  height: 100%;
}
</style>
