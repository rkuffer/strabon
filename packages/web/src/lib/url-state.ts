// lib/url-state.ts
// Synchronise l'état de la carte (année, centre, zoom) avec la query string de
// l'URL, pour qu'un lien copié-collé restaure exactement la vue. Pas de
// vue-router dans ce projet (SPA à page unique) : on manipule directement
// history.replaceState + URLSearchParams, en REPLACE (jamais PUSH) pour ne pas
// polluer l'historique du navigateur à chaque pan/zoom — sinon le bouton
// "précédent" du navigateur deviendrait inutilisable après quelques secondes
// d'exploration de la carte.

export type UrlMapState = {
  year: number;
  lat: number;
  lon: number;
  zoom: number;
};

/**
 * Lit l'état initial depuis la query string au chargement de la page.
 * Chaque champ est optionnel : un paramètre absent ou invalide retombe sur
 * `undefined`, et l'appelant garde alors son défaut habituel (aucune
 * dégradation si l'URL est incomplète ou tapée à la main).
 */
export function readUrlState(): Partial<UrlMapState> {
  const params = new URLSearchParams(window.location.search);
  const year = parseInt(params.get("year") ?? "", 10);
  const lat = parseFloat(params.get("lat") ?? "");
  const lon = parseFloat(params.get("lon") ?? "");
  const zoom = parseFloat(params.get("zoom") ?? "");

  const state: Partial<UrlMapState> = {};
  if (Number.isFinite(year)) state.year = year;
  if (Number.isFinite(lat)) state.lat = lat;
  if (Number.isFinite(lon)) state.lon = lon;
  if (Number.isFinite(zoom)) state.zoom = zoom;
  return state;
}

/**
 * Écrit l'état courant dans l'URL sans recharger la page ni empiler d'entrée
 * d'historique (replaceState). Précision réduite sur lat/lon (3 décimales,
 * ~110m au niveau de l'équateur) pour garder l'URL lisible et compacte —
 * largement suffisant pour recentrer la carte, on ne vise pas une coordonnée
 * de site au mètre près.
 */
export function writeUrlState(state: UrlMapState) {
  const params = new URLSearchParams(window.location.search);
  params.set("year", String(Math.round(state.year)));
  params.set("lat", state.lat.toFixed(3));
  params.set("lon", state.lon.toFixed(3));
  params.set("zoom", String(Math.round(state.zoom * 10) / 10));

  const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", url);
}
