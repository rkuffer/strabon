<template>
  <!-- Pas de template — Leaflet gère le DOM -->
</template>

<script setup lang="ts">
import { watch, onUnmounted, computed, toRef } from "vue";
import L from "leaflet";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { useHullsQuery } from "../../api/client";
import type { HullFeature, HullKind, RoleQualifier } from "@strabon/shared";

const mapStore = useMapStore();
const temporal = useTemporalStore();

let visualLayer: L.GeoJSON | null = null;
let hitLayer: L.GeoJSON | null = null;

const KIND_LABEL: Record<HullKind, string> = {
  polity: "⚔ Polity",
  culture: "🏺 Culture",
  religion: "☾ Religion",
  language: "✎ Language",
};

const ROLE_LABEL: Record<RoleQualifier, string> = {
  state: "state",
  major: "major",
  minor: "minor",
  minority: "community",
};

/**
 * Fill opacity carries the role: a state religion reads as a solid territory,
 * a scattered minority as a faint presence. Step tracks have no role and sit
 * at a fixed middle value.
 */
const ROLE_OPACITY: Record<RoleQualifier, number> = {
  state: 0.3,
  major: 0.24,
  minor: 0.17,
  minority: 0.12,
};
const DEFAULT_OPACITY = 0.26;

function fillOpacityOf(f: any): number {
  const role = f?.properties?.top_role as RoleQualifier | null | undefined;
  return role ? ROLE_OPACITY[role] : DEFAULT_OPACITY;
}

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

// ── Tooltip ──────────────────────────────────────────────────────────────────
// Only one kind is displayed at a time now, but hulls of the SAME kind still
// overlap (co-occurrent religions routinely do), so we keep listing everything
// under the cursor.
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
      const p = f.properties;
      const kind = KIND_LABEL[p.kind] ?? p.kind;
      const count = p.site_count;
      const role = p.top_role ? ` · ${ROLE_LABEL[p.top_role]}` : "";
      const family = p.family_label
        ? `<br/><small style="opacity:.65">${p.family_label}</small>`
        : "";
      return (
        `<span style="font-size:10px;color:${p.color};letter-spacing:.06em;text-transform:uppercase">${kind}${role}</span>` +
        `<br/><strong style="font-size:14px">${p.name}</strong>` +
        family +
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
    // The stroke is a darkened shade of the fill (see hull-color.ts). It is what
    // separates two contiguous hulls whose hues happen to land close together —
    // in a printed atlas, adjacent territories are told apart by their border,
    // not by their wash. It is blurred along with the fill, keeping the soft
    // edge that honestly conveys how uncertain a hull built from points is.
    visualLayer = L.geoJSON(undefined, {
      style: (feature) => ({
        color: feature?.properties?.stroke ?? "transparent",
        weight: 2,
        opacity: 0.55,
        fillColor: feature?.properties?.color ?? "#c9a84c",
        fillOpacity: fillOpacityOf(feature),
        className: "hull-blurred",
      }),
    }).addTo(map);

    // ── Layer hit invisible ───────────────────────────────────────────────────
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
const kindRef = toRef(mapStore, "hullKind");
const minRoleRef = toRef(mapStore, "hullMinRole");

const { data: hullData } = useHullsQuery(yearRef, kindRef, minRoleRef);

function clearLayers() {
  visualLayer?.clearLayers();
  hitLayer?.clearLayers();
}

watch(hullData, (fc) => {
  clearLayers();
  if (!fc) return;
  visualLayer?.addData(fc as any);
  hitLayer?.addData(fc as any);
});

// Switching the layer off must wipe the map immediately: the query is disabled,
// so it will never fire and never clear the stale features by itself.
watch(kindRef, (k) => {
  if (k == null) clearLayers();
});

onUnmounted(() => {
  visualLayer?.remove();
  visualLayer = null;
  hitLayer?.remove();
  hitLayer = null;
});
</script>
