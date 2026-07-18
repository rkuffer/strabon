import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch, type Ref } from "vue";
import type {
  SiteState,
  HullFeature,
  SiteSearchResult,
  HullKind,
  RoleQualifier,
} from "@strabon/shared";
import { useTemporalStore } from "../stores/temporal";

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json() as Promise<T>;
}

// ── Debounce helper ───────────────────────────────────────────────────────────

function useDebounced<T>(source: Ref<T>, delay: number): Ref<T> {
  const debounced = ref(source.value) as Ref<T>;
  let timer: ReturnType<typeof setTimeout> | null = null;

  watch(source, (val) => {
    // Pendant le play, on applique immédiatement sans debounce
    // pour que TanStack Query déclenche bien le fetch à chaque tick
    const temporal = useTemporalStore();
    if (temporal.playing) {
      if (timer) clearTimeout(timer);
      debounced.value = val;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      debounced.value = val;
    }, delay);
  });

  return debounced;
}

// ── Sites query ───────────────────────────────────────────────────────────────

export type SiteFilter = "timeline_only" | "all" | "no_timeline";

export type SiteQueryParams = {
  year: Ref<number>;
  zoom: Ref<number>;
  minLon: Ref<number>;
  minLat: Ref<number>;
  maxLon: Ref<number>;
  maxLat: Ref<number>;
  siteFilter: Ref<SiteFilter>;
};

// Délai de debounce en ms
// — slider manuel : 350ms suffit pour laisser l'utilisateur finir son geste
// — animation : 600ms évite de spammer pendant le play
const YEAR_DEBOUNCE = 350;
const BBOX_DEBOUNCE = 400; // le déplacement de carte est moins urgent

export function useSitesQuery(params: SiteQueryParams) {
  // L'année se débounce seule (source indépendante : slider / lecture auto).
  const dYear = useDebounced(params.year, YEAR_DEBOUNCE);

  // Le bbox ET le zoom se débouncent EN UN SEUL BLOC. Deux bugs distincts
  // étaient en jeu :
  // (1) débouncer les quatre bornes séparément (un useDebounced par borne)
  //     donnait à chacune son propre setTimeout, donc chaque affectation
  //     `debounced.value = val` tombait dans un MACROTASK distinct que Vue ne
  //     peut pas regrouper → quatre changements successifs de queryKey pour un
  //     seul déplacement, donc quatre requêtes ne faisant varier qu'une borne
  //     chacune (signature observée dans l'onglet réseau) ;
  // (2) `zoom` n'était PAS débouncé du tout et alimentait la queryKey en
  //     direct → un clic sur +/- partait immédiatement avec l'ANCIEN bbox,
  //     puis le bbox débouncé relançait une seconde requête.
  // Zoom et bbox décrivent le même état de vue et changent toujours ensemble :
  // un objet unique = un timer unique = une seule invalidation.
  const view = computed(() => ({
    zoom: params.zoom.value,
    minLon: params.minLon.value,
    minLat: params.minLat.value,
    maxLon: params.maxLon.value,
    maxLat: params.maxLat.value,
  }));
  const dView = useDebounced(view, BBOX_DEBOUNCE);

  const url = computed(
    () =>
      `/api/sites?year=${dYear.value}` +
      `&zoom=${dView.value.zoom}` +
      `&minLon=${dView.value.minLon.toFixed(4)}` +
      `&minLat=${dView.value.minLat.toFixed(4)}` +
      `&maxLon=${dView.value.maxLon.toFixed(4)}` +
      `&maxLat=${dView.value.maxLat.toFixed(4)}` +
      `&filter=${params.siteFilter.value}`,
  );

  return useQuery({
    queryKey: computed(() => [
      "sites",
      dYear.value,
      dView.value.zoom,
      params.siteFilter.value,
      // Arrondir le bbox pour limiter les invalidations de cache lors des micro-déplacements
      Math.round(dView.value.minLon * 10) / 10,
      Math.round(dView.value.minLat * 10) / 10,
      Math.round(dView.value.maxLon * 10) / 10,
      Math.round(dView.value.maxLat * 10) / 10,
    ]),
    queryFn: () => fetchJson<SiteState[]>(url.value),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// ── Hulls query ───────────────────────────────────────────────────────────────

/**
 * One hull kind at a time. When no kind is selected the query is disabled and
 * the route is never called.
 */
export function useHullsQuery(
  year: Ref<number>,
  kind: Ref<HullKind | null>,
  minRole: Ref<RoleQualifier>,
) {
  const dYear = useDebounced(year, YEAR_DEBOUNCE);
  const enabled = computed(() => kind.value != null);

  return useQuery({
    queryKey: computed(() => ["hulls", dYear.value, kind.value, minRole.value]),
    queryFn: () =>
      fetchJson<{ type: "FeatureCollection"; features: HullFeature[] }>(
        `/api/hulls?year=${dYear.value}` +
          `&kind=${kind.value}` +
          `&minRole=${minRole.value}`,
      ),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// ── Site detail ───────────────────────────────────────────────────────────────

export function useSiteDetailQuery(id: Ref<string | null>) {
  return useQuery({
    queryKey: computed(() => ["site", id.value]),
    queryFn: () => (id.value ? fetchJson(`/api/sites/${id.value}`) : null),
    enabled: computed(() => id.value != null),
    staleTime: 60_000,
  });
}

// ── Recherche de sites (autocomplete) ─────────────────────────────────────────

// Debounce plus court que le slider : l'autocomplete doit rester réactif.
const SEARCH_DEBOUNCE = 250;
const SEARCH_MIN_CHARS = 2;

export function useSiteSearchQuery(q: Ref<string>) {
  const dq = useDebounced(q, SEARCH_DEBOUNCE);
  const term = computed(() => dq.value.trim());
  const enabled = computed(() => term.value.length >= SEARCH_MIN_CHARS);

  return useQuery({
    queryKey: computed(() => ["site-search", term.value]),
    queryFn: () =>
      fetchJson<SiteSearchResult[]>(
        `/api/search?q=${encodeURIComponent(term.value)}`,
      ),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// ── Données de référence (quasi-statiques) ────────────────────────────────────

export async function fetchPolities() {
  return fetchJson("/api/polities");
}
export async function fetchCultures() {
  return fetchJson("/api/cultures");
}
