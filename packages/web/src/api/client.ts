import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch, type Ref } from "vue";
import type { SiteState, HullFeature, SiteSearchResult } from "@strabon/shared";
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
  // Débouncer l'année et le bbox séparément
  const dYear = useDebounced(params.year, YEAR_DEBOUNCE);
  const dMinLon = useDebounced(params.minLon, BBOX_DEBOUNCE);
  const dMinLat = useDebounced(params.minLat, BBOX_DEBOUNCE);
  const dMaxLon = useDebounced(params.maxLon, BBOX_DEBOUNCE);
  const dMaxLat = useDebounced(params.maxLat, BBOX_DEBOUNCE);

  const url = computed(
    () =>
      `/api/sites?year=${dYear.value}` +
      `&zoom=${params.zoom.value}` +
      `&minLon=${dMinLon.value.toFixed(4)}` +
      `&minLat=${dMinLat.value.toFixed(4)}` +
      `&maxLon=${dMaxLon.value.toFixed(4)}` +
      `&maxLat=${dMaxLat.value.toFixed(4)}` +
      `&filter=${params.siteFilter.value}`,
  );

  return useQuery({
    queryKey: computed(() => [
      "sites",
      dYear.value,
      params.zoom.value,
      params.siteFilter.value,
      // Arrondir le bbox pour limiter les invalidations de cache lors des micro-déplacements
      Math.round(dMinLon.value * 10) / 10,
      Math.round(dMinLat.value * 10) / 10,
      Math.round(dMaxLon.value * 10) / 10,
      Math.round(dMaxLat.value * 10) / 10,
    ]),
    queryFn: () => fetchJson<SiteState[]>(url.value),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// ── Hulls query ───────────────────────────────────────────────────────────────

export function useHullsQuery(
  year: Ref<number>,
  type: Ref<string> = { value: "both" } as Ref<string>,
) {
  const dYear = useDebounced(year, YEAR_DEBOUNCE);

  return useQuery({
    queryKey: computed(() => ["hulls", dYear.value, type.value]),
    queryFn: () =>
      fetchJson<{ type: "FeatureCollection"; features: HullFeature[] }>(
        `/api/hulls?year=${dYear.value}&type=${type.value}`,
      ),
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
