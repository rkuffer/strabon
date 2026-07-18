<!-- MapContainer.vue — Initialise Leaflet et orchestre les layers -->
<template>
  <div ref="mapEl" class="map-container">
    <SiteMarkers v-if="mapStore.leafletMap" />
    <HullLayer v-if="mapStore.leafletMap" />
    <HullControl v-if="mapStore.leafletMap" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { readUrlState, writeUrlState } from "../../lib/url-state";
import SiteMarkers from "./SiteMarkers.vue";
import HullLayer from "./HullLayer.vue";
import HullControl from "./HullControl.vue";

const mapEl = ref<HTMLDivElement>();
const mapStore = useMapStore();
const temporal = useTemporalStore();

let map: L.Map | null = null;
let moveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  if (!mapEl.value) return;

  // Lien profond : si l'URL porte year/lat/lon/zoom, on démarre la carte à
  // cette position plutôt qu'à la vue par défaut. Un paramètre manquant ou
  // invalide retombe silencieusement sur son défaut habituel.
  const urlState = readUrlState();
  if (urlState.year !== undefined) temporal.setYear(urlState.year);

  const initialCenter: [number, number] =
    urlState.lat !== undefined && urlState.lon !== undefined
      ? [urlState.lat, urlState.lon]
      : [30, 15];
  // Sous zoom 0, plus rien de sensé à afficher avec ce fournisseur de tuiles —
  // on borne même un lien profond farfelu (ex. zoom=-5 tapé à la main).
  const initialZoom = Math.max(0, urlState.zoom ?? 3);

  // Zoom 2 est le plancher normal (molette, boutons +/-) : en dessous, rien
  // d'utile à voir sur cette carte. On ne le SERRE PAS si un lien profond
  // demande explicitement moins — dans ce cas le plancher devient cette
  // valeur pour la session. Leaflet n'a qu'un seul plancher global (pas de
  // "2 en usage normal, libre en dessous via URL" totalement découplés) :
  // c'est le compromis le plus proche de la demande sans réécrire la
  // gestion du zoom de Leaflet.
  const minZoom = Math.min(2, initialZoom);

  map = L.map(mapEl.value, {
    center: initialCenter,
    zoom: initialZoom,
    minZoom,
    // Empêche de faire glisser la carte vers des latitudes où la projection
    // Web Mercator n'a plus de sens (au-delà de ±85°, les pôles sont à
    // l'infini dans cette projection) et bloque la dérive Est/Ouest avant de
    // sortir la carte du cadre. Marge de ±200 (au lieu de ±180 strict) pour
    // ne pas "cogner" brutalement sur l'antiméridien — évite un mur sec tout
    // en empêchant de dériver dans le vide gris indéfiniment.
    maxBounds: L.latLngBounds(L.latLng(-85, -200), L.latLng(85, 200)),
    maxBoundsViscosity: 1.0,
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

  // Écrit l'état courant (année + centre + zoom) dans l'URL. En replaceState
  // (jamais push), sinon chaque pan/zoom empilerait une entrée d'historique.
  function syncUrl() {
    writeUrlState({
      year: temporal.year,
      lat: mapStore.centerLat,
      lon: mapStore.centerLng,
      zoom: mapStore.zoom,
    });
  }

  // Débounce + garde du handler moveend/zoomend — PAS un réglage cosmétique.
  // Leaflet peut déclencher plusieurs "moveend"/"zoomend" pendant une seule
  // transition animée (clic +/-, molette, flyTo), avec des bounds différents
  // à chaque frame intermédiaire (mesuré : jusqu'à 4-5 requêtes réseau pour
  // un seul clic, un simple debounce à fenêtre fixe ne suffisant pas si
  // l'écart entre ces events dépasse la fenêtre). Voir le détail dans
  // onMapSettled ci-dessous.
  const MOVE_DEBOUNCE_MS = 150;

  function onMapSettled() {
    const m = map as any;
    if (m?._animatingZoom) {
      // Animation encore en cours : on réessaie au frame suivant plutôt que
      // d'abandonner l'événement. Les boutons +/- zooment autour du CENTRE de
      // la carte (contrairement à la molette qui zoome vers le curseur) — le
      // centre ne bouge alors pas, donc Leaflet peut ne déclencher QUE
      // "zoomend" sans "moveend" du tout. Si ce zoomend unique arrive pendant
      // que _animatingZoom est encore vrai, un simple `return` le perdrait
      // définitivement : plus aucune mise à jour ne surviendrait pour ce
      // clic. Le polling garantit qu'on finit par agir, quel que soit
      // l'ordre exact des events Leaflet.
      requestAnimationFrame(onMapSettled);
      return;
    }

    if (moveDebounceTimer) clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(() => {
      if (map) mapStore.updateFromMap(map);
      syncUrl();
    }, MOVE_DEBOUNCE_MS);
  }

  map.on("moveend zoomend", onMapSettled);

  // Le curseur temporel (scrubber/lecture auto) ne déclenche pas moveend —
  // il faut synchroniser l'URL séparément sur les changements d'année.
  watch(() => temporal.year, syncUrl);

  // Position initiale dans l'URL dès le chargement (utile si l'utilisateur
  // arrive sans paramètres : l'URL se remplit avec la vue par défaut).
  syncUrl();
});

onUnmounted(() => {
  if (moveDebounceTimer) clearTimeout(moveDebounceTimer);
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
