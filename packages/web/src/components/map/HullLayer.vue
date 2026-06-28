<template>
  <!-- Pas de template — Leaflet gère le DOM -->
</template>

<script setup lang="ts">
import { watch, onUnmounted, computed } from "vue";
import L from "leaflet";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { useHullsQuery } from "../../api/client";
import type { HullFeature } from "@strabon/shared";

const mapStore = useMapStore();
const temporal = useTemporalStore();

let visualLayer: L.GeoJSON | null = null;
let hitLayer: L.GeoJSON | null = null;

// ── Filtre SVG blur ───────────────────────────────────────────────────────────
function injectBlurFilter(map: L.Map) {
  const svgEl = map.getContainer().querySelector("svg.leaflet-zoom-animated");
  if (!svgEl || svgEl.querySelector("#hull-blur")) return;
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <filter id="hull-blur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" />
    </filter>
  `;
  svgEl.prepend(defs);
}

// ── Tooltip combiné : liste tous les hulls sous le curseur ────────────────────
// Quand polity et culture se superposent, on affiche les deux dans un seul tooltip
let currentFeatures: HullFeature[] = [];

function buildCombinedTooltip(latlng: L.LatLng): string {
  if (!hitLayer) return "";
  const matching: HullFeature[] = [];
  hitLayer.eachLayer((layer: any) => {
    if (layer.feature && layer.getBounds().contains(latlng)) {
      matching.push(layer.feature as HullFeature);
    }
  });

  if (!matching.length) return "";

  return matching
    .map((f) => {
      const kind = f.properties.kind === "polity" ? "⚔ Polity" : "🏺 Culture";
      const color = f.properties.color ?? "#888";
      const count = f.properties.site_count;
      return (
        `<span style="font-size:10px;color:${color};letter-spacing:.06em;text-transform:uppercase">${kind}</span>` +
        `<br/><strong style="font-size:14px">${f.properties.name}</strong>` +
        `<br/><small>${count} site${count > 1 ? "s" : ""}</small>`
      );
    })
    .join('<hr style="border-color:var(--border);margin:5px 0">');
}

watch(
  () => mapStore.leafletMap,
  (map) => {
    if (!map) return;

    setTimeout(() => injectBlurFilter(map), 300);
    map.on("zoomend", () => injectBlurFilter(map));

    // ── Layer visuel avec blur ────────────────────────────────────────────────
    visualLayer = L.geoJSON(undefined, {
      style: (feature) => ({
        color: "transparent",
        weight: 0,
        fillColor: feature?.properties?.color ?? "#c9a84c",
        fillOpacity: feature?.properties?.kind === "polity" ? 0.28 : 0.2,
        className: "hull-blurred",
      }),
    }).addTo(map);

    // ── Layer hit invisible ───────────────────────────────────────────────────
    // Un seul tooltip par layer, mais on le met à jour dynamiquement
    // pour refléter tous les hulls présents sous le curseur
    const tooltip = L.tooltip({ sticky: true, className: "site-tip" });

    hitLayer = L.geoJSON(undefined, {
      style: () => ({
        color: "transparent",
        weight: 0,
        fillColor: "transparent",
        fillOpacity: 0.001,
      }),
      onEachFeature: (_feature, layer) => {
        layer.on("mouseover", (e: L.LeafletMouseEvent) => {
          const content = buildCombinedTooltip(e.latlng);
          if (content) {
            tooltip.setContent(content);
            tooltip.setLatLng(e.latlng);
            if (!map.hasLayer(tooltip)) tooltip.addTo(map);
          }
        });
        layer.on("mousemove", (e: L.LeafletMouseEvent) => {
          tooltip.setLatLng(e.latlng);
        });
        layer.on("mouseout", () => {
          tooltip.remove();
        });
      },
    }).addTo(map);
  },
  { immediate: true },
);

// ── Mise à jour des données ───────────────────────────────────────────────────
const yearRef = computed(() => temporal.year);
const { data: hullData } = useHullsQuery(yearRef);

watch(hullData, (fc) => {
  if (!fc) return;
  if (visualLayer) {
    visualLayer.clearLayers();
    visualLayer.addData(fc as any);
  }
  if (hitLayer) {
    hitLayer.clearLayers();
    hitLayer.addData(fc as any);
  }
});

onUnmounted(() => {
  visualLayer?.remove();
  visualLayer = null;
  hitLayer?.remove();
  hitLayer = null;
});
</script>
