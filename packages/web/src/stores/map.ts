// stores/map.ts
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { Map as LeafletMap } from "leaflet";
import type { HullKind, RoleQualifier } from "@strabon/shared";

export const useMapStore = defineStore("map", () => {
  const zoom = ref(3);
  const west = ref(-180);
  const south = ref(-90);
  const east = ref(180);
  const north = ref(90);
  const leafletMap = shallowRef<LeafletMap | null>(null);
  const selectedSiteId = ref<string | null>(null);

  /**
   * Which dimension is drawn as hulls. ONE at a time, or none — stacking
   * polity and culture simultaneously was unreadable, and four dimensions
   * would be hopeless. Null means no hull layer at all, and no query.
   */
  const hullKind = ref<HullKind | null>("polity");

  /**
   * Least dominant role that contributes to a hull. Only meaningful on the
   * co-occurrent tracks (religion, language).
   *
   * "major" is the default: the hull of the dominant faith or tongue. Opening
   * it down to "minority" is a deliberate view, and a valuable one — the hull
   * of medieval European Jewish communities is worth drawing.
   */
  const hullMinRole = ref<RoleQualifier>("major");

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
    hullKind,
    hullMinRole,
    setMap,
    updateFromMap,
    focusSite,
  };
});
