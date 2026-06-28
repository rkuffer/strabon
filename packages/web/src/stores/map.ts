// stores/map.ts
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { Map as LeafletMap } from "leaflet";

export const useMapStore = defineStore("map", () => {
  const zoom = ref(3);
  const west = ref(-180);
  const south = ref(-90);
  const east = ref(180);
  const north = ref(90);
  const leafletMap = shallowRef<LeafletMap | null>(null);
  const selectedSiteId = ref<string | null>(null);

  function setMap(map: LeafletMap) {
    leafletMap.value = map;
  }

  function updateFromMap(map: LeafletMap) {
    zoom.value = map.getZoom();
    const b = map.getBounds();
    west.value = b.getWest();
    south.value = b.getSouth();
    east.value = b.getEast();
    north.value = b.getNorth();
  }

  /**
   * Recentre la carte sur un site (recherche, lien direct…) avec une animation
   * douce. On zoome au moins à `minZoom` pour que le site soit clairement cadré,
   * sans dézoomer si l'utilisateur était déjà plus serré.
   */
  function focusSite(
    lat: number,
    lon: number,
    opts: { id?: string | null; minZoom?: number } = {},
  ) {
    selectedSiteId.value = opts.id ?? null;
    const m = leafletMap.value;
    if (!m) return;
    const target = Math.max(m.getZoom(), opts.minZoom ?? 8);
    m.flyTo([lat, lon], target, { duration: 0.8 });
  }

  return {
    zoom,
    west,
    south,
    east,
    north,
    leafletMap,
    selectedSiteId,
    setMap,
    updateFromMap,
    focusSite,
  };
});
