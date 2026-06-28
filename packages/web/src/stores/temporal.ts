// stores/temporal.ts
import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { getPlayStep } from "@strabon/shared";

export type SiteFilter = "timeline_only" | "all" | "no_timeline";

export const useTemporalStore = defineStore("temporal", () => {
  const year = ref(1);
  const playing = ref(false);
  const siteFilter = ref<SiteFilter>("timeline_only");

  // Exposé par SiteMarkers pour bloquer le play pendant un fetch
  const isFetching = ref(false);

  const yearDisplay = computed(() => {
    const abs = Math.abs(year.value) || 1;
    return {
      value: abs.toLocaleString(),
      era: year.value <= 0 ? "BC" : "AD",
    };
  });

  const showUndated = computed(() => siteFilter.value !== "timeline_only");
  const timelineOnly = computed(() => siteFilter.value === "timeline_only");
  const noTimelineOnly = computed(() => siteFilter.value === "no_timeline");

  function setYear(y: number) {
    year.value = Math.max(-10000, Math.min(2000, y));
  }

  // ── Lecture automatique ───────────────────────────────────────────────────
  // On utilise un setTimeout récursif plutôt qu'un setInterval :
  // chaque tick n'est planifié qu'après que le fetch précédent soit terminé,
  // ce qui évite de spammer le back pendant l'animation.
  const PLAY_INTERVAL = 2000; // ms d'attente après réception des données
  let playTimeout: ReturnType<typeof setTimeout> | null = null;

  function tick() {
    if (!playing.value) return;

    // Si un fetch est en cours, on réessaie dans 200ms
    if (isFetching.value) {
      playTimeout = setTimeout(tick, 100);
      return;
    }

    const next = year.value + getPlayStep(year.value);
    if (next > 2000) {
      year.value = 2000;
      playing.value = false;
      return;
    }
    year.value = next;
    playTimeout = setTimeout(tick, PLAY_INTERVAL);
  }

  function stopPlay() {
    if (playTimeout) {
      clearTimeout(playTimeout);
      playTimeout = null;
    }
  }

  watch(playing, (val) => {
    if (val) tick();
    else stopPlay();
  });

  return {
    year,
    playing,
    isFetching,
    siteFilter,
    showUndated,
    timelineOnly,
    noTimelineOnly,
    yearDisplay,
    setYear,
  };
});
