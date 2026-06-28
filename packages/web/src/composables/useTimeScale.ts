// packages/web/src/composables/useTimeScale.ts
// État réactif global du mode d'échelle — partagé entre TimeRuler et TimelineTrack

import { ref } from "vue";
import { toPct, fromScale, GLOBAL_MIN, GLOBAL_MAX } from "@strabon/shared";
import type { ScaleMode } from "@strabon/shared";

// Singleton module-level : un seul état partagé dans toute l'app
const mode = ref<ScaleMode>("sqrt");

export function useTimeScale() {
  function xPct(
    year: number,
    min = GLOBAL_MIN,
    max = GLOBAL_MAX,
  ): number {
    return toPct(year, mode.value, min, max);
  }

  function yearFromPct(
    pct: number,
    min = GLOBAL_MIN,
    max = GLOBAL_MAX,
  ): number {
    return fromScale(pct / 100, mode.value, min, max);
  }

  function setMode(m: ScaleMode) {
    mode.value = m;
  }

  return { mode, xPct, yearFromPct, setMode };
}
