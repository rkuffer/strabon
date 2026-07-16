<template>
  <!-- Pas de template — Leaflet gère le DOM de la carte directement -->
</template>

<script setup lang="ts">
import { watch, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import L from "leaflet";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { useUIStore } from "../../stores/ui";
import { useSitesQuery } from "../../api/client";
import type { SiteState } from "@strabon/shared";

const mapStore = useMapStore();
const temporal = useTemporalStore();
const ui = useUIStore();

// ── Formes SVG figuratives par site_type ──────────────────────────────────────
// Chaque forme est dessinée dans un viewBox 0 0 32 32, centrée verticalement pour
// pouvoir être ancrée sur son point géographique (pas de tige, pas de décalage).
// Les icônes portent leur propre palette (toit terre cuite, mur parchemin, etc.) :
// la FORME encode la nature du site, la TAILLE encode l'importance.
type ShapeFn = () => string;

const SHAPES: Record<string, ShapeFn> = {
  // Campement : tente conique seule
  campsite: () =>
    `<path d="M4,25 L16,7 L28,25 Z" fill="#C77B3A" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="M13,25 L16,17 L19,25 Z" fill="#2a1a10"/>`,

  // Hameau : petite maison (toit + mur), volontairement nue pour rester lisible
  settlement: () =>
    `<path d="M6,15 L16,6 L26,15 Z" fill="#C77B3A" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="8" y="15" width="16" height="11" fill="#E8C9A0" stroke="#1a1a1a" stroke-width="2"/>`,

  // Village : maison avec porte
  village: () =>
    `<path d="M5,15 L16,6 L27,15 Z" fill="#C77B3A" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="7" y="15" width="18" height="12" fill="#E8C9A0" stroke="#1a1a1a" stroke-width="2"/>` +
    `<rect x="14" y="19" width="6" height="8" fill="#2a1a10"/>`,

  // Bourg : deux bâtiments accolés
  town: () =>
    `<path d="M2,16 L11,7 L20,16 Z" fill="#D98B45" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="4" y="16" width="14" height="11" fill="#E8C9A0" stroke="#1a1a1a" stroke-width="2"/>` +
    `<path d="M13,20 L22,12 L31,20 Z" fill="#C77B3A" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="15" y="20" width="14" height="7" fill="#F0DBBB" stroke="#1a1a1a" stroke-width="2"/>`,

  // Ville : silhouette d'immeubles
  city: () =>
    `<rect x="2" y="12" width="7" height="15" fill="#9C7B52" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="10" y="5" width="7" height="22" fill="#B8946A" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="18" y="10" width="7" height="17" fill="#9C7B52" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="26" y="15" width="4" height="12" fill="#B8946A" stroke="#1a1a1a" stroke-width="1.5"/>`,

  // Métropole : immeubles plus hauts et plus nombreux
  metropolis: () =>
    `<rect x="1" y="13" width="6" height="14" fill="#9C7B52" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="8" y="6" width="6" height="21" fill="#B8946A" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="15" y="2" width="6" height="25" fill="#C9A878" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="22" y="9" width="6" height="18" fill="#B8946A" stroke="#1a1a1a" stroke-width="1.5"/>`,

  // Capitale : immeubles + repère doré (étoile)
  capital: () =>
    `<rect x="2" y="12" width="7" height="15" fill="#9C7B52" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="12" y="4" width="8" height="23" fill="#B8946A" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="23" y="10" width="7" height="17" fill="#9C7B52" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<path d="M16,1 L19,5 L16,9 L13,5 Z" fill="#F2C744" stroke="#1a1a1a" stroke-width="1"/>`,

  // Port : jetée sur pilotis + barque à voile + ligne d'eau
  port: () =>
    `<line x1="2" y1="22" x2="20" y2="22" stroke="#8a6a48" stroke-width="3"/>` +
    `<line x1="6" y1="22" x2="6" y2="26" stroke="#8a6a48" stroke-width="2"/>` +
    `<line x1="16" y1="22" x2="16" y2="26" stroke="#8a6a48" stroke-width="2"/>` +
    `<path d="M18,18 L30,18 L27,23 L21,23 Z" fill="#D98B45" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<line x1="24" y1="18" x2="24" y2="6" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<path d="M24,7 L24,16 L31,12 Z" fill="#E8C9A0" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M1,26 Q7,29 13,26 T25,26" fill="none" stroke="#5EC9D6" stroke-width="1.5"/>`,

  // Colonie : maison à toit vert + fanion
  colony: () =>
    `<path d="M6,16 L16,7 L26,16 Z" fill="#7BA86E" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="8" y="16" width="16" height="11" fill="#D6E3C8" stroke="#1a1a1a" stroke-width="2"/>` +
    `<line x1="16" y1="7" x2="16" y2="2" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<path d="M16,2 L23,4 L16,7 Z" fill="#C77B3A" stroke="#1a1a1a" stroke-width="1" stroke-linejoin="round"/>`,

  // Administratif : bâtiment à colonnades
  administrative: () =>
    `<path d="M4,12 L16,5 L28,12 Z" fill="#B8946A" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="6" y="12" width="20" height="14" fill="#E0D2B8" stroke="#1a1a1a" stroke-width="2"/>` +
    `<line x1="10" y1="14" x2="10" y2="26" stroke="#1a1a1a" stroke-width="2"/>` +
    `<line x1="16" y1="14" x2="16" y2="26" stroke="#1a1a1a" stroke-width="2"/>` +
    `<line x1="22" y1="14" x2="22" y2="26" stroke="#1a1a1a" stroke-width="2"/>`,

  // Forteresse : donjon crénelé rouge brique
  fortress: () =>
    `<path d="M5,10 L5,6 L9,6 L9,9 L13,9 L13,6 L19,6 L19,9 L23,9 L23,6 L27,6 L27,10 Z" fill="#B0453A" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<rect x="5" y="10" width="22" height="16" fill="#C1554A" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<rect x="13" y="17" width="6" height="9" fill="#2a1a10"/>`,

  // Site religieux : édifice conique (clocher/temple), sans symbole confessionnel
  religious_site: () =>
    `<path d="M16,3 L26,25 L6,25 Z" fill="#D9CBB0" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<circle cx="16" cy="10" r="2.2" fill="#8a6a48" stroke="#1a1a1a" stroke-width="1"/>` +
    `<path d="M12,25 L12,19 Q16,14 20,19 L20,25 Z" fill="#8a6a48" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>`,

  // Ruines : pans de murs debout (structure encore lisible)
  ruins: () =>
    `<path d="M5,26 L5,9 L9,9 L9,15 L11,15 L11,11 L14,11 L14,26 Z" fill="#9a9488" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M18,26 L18,14 L21,14 L21,19 L24,19 L24,10 L27,10 L27,26 Z" fill="#8f897d" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<line x1="2" y1="26" x2="30" y2="26" stroke="#6a655c" stroke-width="2"/>`,

  // Abandonné : ruines effondrées (contours brisés, plus rien de plein)
  abandoned: () =>
    `<path d="M4,26 L4,13 L8,13 L8,19 L4,19 M8,13 L12,9 L12,26" fill="none" stroke="#7a746a" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="M13,26 L13,17 L19,17 L19,23 L16,23" fill="none" stroke="#6a655c" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="M21,26 L21,15 L27,19 L27,26" fill="none" stroke="#7a746a" stroke-width="2" stroke-linejoin="round"/>` +
    `<line x1="2" y1="26" x2="30" y2="26" stroke="#5a554c" stroke-width="2"/>`,

  default: () =>
    `<path d="M6,15 L16,6 L26,15 Z" fill="#C77B3A" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>` +
    `<rect x="8" y="15" width="16" height="11" fill="#E8C9A0" stroke="#1a1a1a" stroke-width="2"/>`,
};

// capital_city est un alias de capital
SHAPES.capital_city = SHAPES.capital;

// ── Taille dynamique : racine douce du score × plafond par zoom ───────────────
// La taille (côté de l'icône, en px) combine deux facteurs :
//   1. le score combiné computed_importance (base_importance sitelinks +
//      type_score + pop), via une racine carrée pour que les petits scores
//      gagnent des pixels vite et que les capitales n'écrasent pas le reste ;
//   2. le niveau de zoom, qui borne la fourchette [min..max] : au monde entier
//      les icônes sont petites (moins de collisions), au zoom fort l'écart de
//      score reprend toute son ampleur.
const SCORE_MAX = 170; // plafond de référence (~capital + fort sitelinks + pop)

// Fourchette de tailles (px) interpolée selon le zoom Leaflet (~2 = monde,
// ~10+ = rue). En dessous/au-dessus, on clampe.
const ZOOM_LO = 2;
const ZOOM_HI = 10;
const SIZE_MIN_AT_LO = 6; // plus petit marker, monde entier
const SIZE_MAX_AT_LO = 14; // plus gros marker, monde entier
const SIZE_MIN_AT_HI = 14; // plus petit marker, zoom fort
const SIZE_MAX_AT_HI = 40; // plus gros marker, zoom fort

function sizeRangeForZoom(zoom: number): { min: number; max: number } {
  const z = Math.min(ZOOM_HI, Math.max(ZOOM_LO, zoom));
  const t = (z - ZOOM_LO) / (ZOOM_HI - ZOOM_LO); // 0 (monde) → 1 (rue)
  return {
    min: SIZE_MIN_AT_LO + t * (SIZE_MIN_AT_HI - SIZE_MIN_AT_LO),
    max: SIZE_MAX_AT_LO + t * (SIZE_MAX_AT_HI - SIZE_MAX_AT_LO),
  };
}

function sizeForScore(score: number, zoom: number): number {
  const { min, max } = sizeRangeForZoom(zoom);
  const ratio = Math.min(1, Math.max(0, score / SCORE_MAX));
  return Math.round(min + (max - min) * Math.sqrt(ratio));
}

// ── Fabrique d'icônes avec cache (clé = type + taille arrondie) ───────────────
// La taille encode déjà score ET zoom : la clé type:size suffit à distinguer les
// variantes, inutile d'ajouter le zoom séparément.
const iconCache = new Map<string, L.DivIcon>();

function makeIcon(siteType: string, score: number, zoom: number): L.DivIcon {
  const size = sizeForScore(score, zoom);
  const key = `${siteType}:${size}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const shape = (SHAPES[siteType] ?? SHAPES.default)();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">` +
    `${shape}</svg>`;

  const icon = L.divIcon({
    html: svg,
    className: "",
    iconSize: [size, size],
    // Ancrage au CENTRE : l'icône est posée sur sa coordonnée réelle, sans tige
    // ni décalage vers le nord.
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });

  iconCache.set(key, icon);
  return icon;
}

// ── Layer Leaflet ─────────────────────────────────────────────────────────────
const markerLayer = L.layerGroup();
const markerMap = new Map<string, L.Marker>();
// Dernier jeu de sites reçu — permet de re-tailler les markers sur simple
// changement de zoom, sans attendre un refetch.
let lastSites: SiteState[] = [];

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
    lastSites = newSites;
    updateMarkers(newSites);
  },
  { immediate: true },
);

// Re-tailler les markers existants quand le zoom change (la fourchette de
// tailles dépend du zoom). Le refetch lié au zoom fait déjà repasser par
// watch(sites), mais ce watch garantit le redimensionnement même si les données
// ne changent pas.
watch(zoom, () => {
  if (lastSites.length) updateMarkers(lastSites);
});

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
    // L'icône dépend maintenant du type, du score ET du zoom : elle doit se
    // rafraîchir à chaque changement d'année (computed_importance varie avec la
    // population et le site_type effectif) comme de zoom. makeIcon est caché,
    // l'appel systématique est bénin.
    const icon = makeIcon(site.site_type, site.computed_importance, zoom.value);

    if (markerMap.has(site.id)) {
      markerMap.get(site.id)!.setIcon(icon);
    } else {
      const marker = L.marker([site.lat, site.lon], {
        icon,
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
