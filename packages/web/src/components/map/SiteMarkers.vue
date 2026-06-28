<template>
  <!-- Pas de template — Leaflet gère le DOM de la carte directement -->
</template>

<script setup lang="ts">
import { watch, onUnmounted, computed } from "vue";
import { storeToRefs } from "pinia";
import L from "leaflet";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { useUIStore } from "../../stores/ui";
import { useSitesQuery } from "../../api/client";
import type { SiteState, SiteType } from "@strabon/shared";

const mapStore = useMapStore();
const temporal = useTemporalStore();
const ui = useUIStore();

// ── Couleurs par site_type ────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  campsite: "#6b5e7a",
  settlement: "#7a6e52",
  village: "#5c7a5a",
  town: "#4a7a8a",
  city: "#4a6aaa",
  metropolis: "#3a4aaa",
  capital: "#c9a84c",
  capital_city: "#c9a84c",
  religious_site: "#aa6a4a",
  fortress: "#7a4a3a",
  port: "#3a8aaa",
  colony: "#6a8a4a",
  administrative: "#8a7a5a",
  ruins: "#5a5a5a",
  abandoned: "#3a3a3a",
  default: "#6b6b5a",
};

// ── Formes SVG par site_type ──────────────────────────────────────────────────
type ShapeFn = (c: string) => string;

const SHAPES: Record<string, ShapeFn> = {
  campsite: (c) =>
    `<circle cx="10" cy="10" r="4" fill="${c}" fill-opacity=".3" stroke="${c}" stroke-width="1.5"/>`,
  settlement: (c) =>
    `<circle cx="10" cy="10" r="5.5" fill="${c}" fill-opacity=".85" stroke="#0e0f0e" stroke-width="1"/>`,
  village: (c) =>
    `<polygon points="10,3 17,14 3,14" fill="${c}" fill-opacity=".85" stroke="#0e0f0e" stroke-width="1"/>`,
  town: (c) =>
    `<rect x="3.5" y="3.5" width="13" height="13" rx="2" fill="${c}" fill-opacity=".85" stroke="#0e0f0e" stroke-width="1"/>`,
  city: (c) =>
    `<polygon points="10,2 18,7.5 15.5,17 4.5,17 2,7.5" fill="${c}" fill-opacity=".9" stroke="#0e0f0e" stroke-width="1"/>`,
  metropolis: (c) =>
    `<polygon points="10,1 19,6.5 16,18 4,18 1,6.5" fill="${c}" fill-opacity=".95" stroke="#0e0f0e" stroke-width="1.5"/><circle cx="10" cy="11" r="2.5" fill="#0e0f0e" fill-opacity=".5"/>`,
  capital: (c) =>
    `<polygon points="10,1.5 12.5,7.5 19.5,7.5 13.5,12 15.5,19 10,14.5 4.5,19 6.5,12 0.5,7.5 7.5,7.5" fill="${c}" fill-opacity=".92" stroke="#0e0f0e" stroke-width=".8"/>`,
  capital_city: (c) =>
    `<polygon points="10,1.5 12.5,7.5 19.5,7.5 13.5,12 15.5,19 10,14.5 4.5,19 6.5,12 0.5,7.5 7.5,7.5" fill="${c}" fill-opacity=".92" stroke="#0e0f0e" stroke-width=".8"/>`,
  religious_site: (c) =>
    `<circle cx="10" cy="10" r="7.5" fill="${c}" fill-opacity=".15" stroke="${c}" stroke-width="1.5"/><line x1="10" y1="2.5" x2="10" y2="17.5" stroke="${c}" stroke-width="1.5"/><line x1="4.5" y1="8" x2="15.5" y2="8" stroke="${c}" stroke-width="1.5"/>`,
  fortress: (c) =>
    `<rect x="2.5" y="6" width="15" height="11" fill="${c}" fill-opacity=".85" stroke="#0e0f0e" stroke-width="1"/><rect x="2.5" y="2.5" width="3.5" height="5.5" fill="${c}" stroke="#0e0f0e" stroke-width="1"/><rect x="8.2" y="2.5" width="3.5" height="5.5" fill="${c}" stroke="#0e0f0e" stroke-width="1"/><rect x="14" y="2.5" width="3.5" height="5.5" fill="${c}" stroke="#0e0f0e" stroke-width="1"/>`,
  ruins: (c) =>
    `<polygon points="10,2.5 17.5,16.5 2.5,16.5" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="3,2"/><circle cx="10" cy="13" r="1.5" fill="${c}"/>`,
  abandoned: (c) =>
    `<circle cx="10" cy="10" r="6.5" fill="none" stroke="${c}" stroke-width="1" stroke-dasharray="2,3"/>`,
  default: (c) =>
    `<circle cx="10" cy="10" r="5.5" fill="${c}" fill-opacity=".85" stroke="#0e0f0e" stroke-width="1"/>`,
};

const STEM = (c: string) =>
  `<line x1="10" y1="19" x2="10" y2="26" stroke="${c}" stroke-opacity=".7" stroke-width="1.2"/>`;

// ── Fabrique d'icônes avec cache ──────────────────────────────────────────────
const iconCache = new Map<string, L.DivIcon>();

function makeIcon(siteType: string): L.DivIcon {
  const key = siteType;
  if (iconCache.has(key)) return iconCache.get(key)!;

  const color = TYPE_COLORS[siteType] ?? TYPE_COLORS.default;
  const shape = (SHAPES[siteType] ?? SHAPES.default)(color);
  const big = ["metropolis", "capital", "capital_city"].includes(siteType);
  const small = ["campsite", "ruins", "abandoned"].includes(siteType);
  const scale = big ? 1.45 : small ? 0.82 : 1;
  const w = Math.round(20 * scale);
  const h = Math.round(28 * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 20 28">${shape}${STEM(color)}</svg>`;

  const icon = L.divIcon({
    html: svg,
    className: "",
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -h],
  });

  iconCache.set(key, icon);
  return icon;
}

// ── Layer Leaflet ─────────────────────────────────────────────────────────────
const markerLayer = L.layerGroup();
const markerMap = new Map<string, L.Marker>();

// Ajouter le layer dès que la carte est disponible
watch(
  () => mapStore.leafletMap,
  (map) => {
    if (map) markerLayer.addTo(map);
  },
  { immediate: true },
);

// Requête TanStack Query — réactive sur year, zoom, bounds
const { year, siteFilter } = storeToRefs(temporal);
const { zoom, west, south, east, north } = storeToRefs(mapStore);

const { data: sites, isFetching } = useSitesQuery({
  year,
  zoom,
  minLon: west,
  minLat: south,
  maxLon: east,
  maxLat: north,
  siteFilter,
});

// Synchroniser l'état de fetch avec le store temporal (pour le play)
watch(
  isFetching,
  (val) => {
    temporal.isFetching = val;
  },
  { immediate: true },
);

// Mettre à jour les markers quand les données changent
watch(
  () => sites.value,
  (newSites) => {
    if (!newSites) return;
    updateMarkers(newSites);
  },
  { immediate: true },
);

function updateMarkers(newSites: SiteState[]) {
  const newIds = new Set(newSites.map((s) => s.id));

  // Supprimer les markers disparus
  for (const [id, marker] of markerMap) {
    if (!newIds.has(id)) {
      markerLayer.removeLayer(marker);
      markerMap.delete(id);
    }
  }

  // Ajouter/mettre à jour
  for (const site of newSites) {
    if (markerMap.has(site.id)) {
      // Mettre à jour l'icône si le site_type a changé
      const marker = markerMap.get(site.id)!;
      marker.setIcon(makeIcon(site.site_type));
    } else {
      const marker = L.marker([site.lat, site.lon], {
        icon: makeIcon(site.site_type),
        title: site.title,
      });

      marker.bindTooltip(buildTooltip(site), {
        className: "site-tip",
        direction: "top",
        offset: [0, -6],
        sticky: false,
      });

      marker.on("click", () => {
        mapStore.selectedSiteId = site.id;
        ui.openPanel();
      });

      markerLayer.addLayer(marker);
      markerMap.set(site.id, marker);
    }
  }
}

function buildTooltip(site: SiteState): string {
  const bits: string[] = [];
  if (site.site_type) bits.push(site.site_type.replace("_", " "));
  if (site.polity) bits.push(site.polity.name);
  const sub = bits.length
    ? `<div class="tip-period">${bits.join(" · ")}</div>`
    : "";
  return `<div class="tip-title">${site.title}</div>${sub}`;
}

onUnmounted(() => {
  markerLayer.remove();
  markerMap.clear();
  iconCache.clear();
});
</script>
