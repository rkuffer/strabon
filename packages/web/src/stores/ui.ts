// stores/ui.ts
import { defineStore } from "pinia";
import { ref } from "vue";

export type ActiveLayer = "sites" | "polities" | "cultures" | "all";

export const useUIStore = defineStore("ui", () => {
  const panelOpen = ref(false);
  const legendOpen = ref(false);
  const activeLayer = ref<ActiveLayer>("all");

  function openPanel() { panelOpen.value = true; }
  function closePanel() { panelOpen.value = false; }
  function toggleLegend() { legendOpen.value = !legendOpen.value; }

  return { panelOpen, legendOpen, activeLayer, openPanel, closePanel, toggleLegend };
});
