<template>
  <div
    class="timeline-panel"
    :class="{ open: ui.panelOpen, expanded: expanded, resizing: resizing }"
    :style="{ '--panel-h': panelHeight + 'px' }"
  >
    <!-- Poignée de redimensionnement — masquée en mode liste (pleine hauteur) -->
    <div
      v-if="!expanded"
      class="panel-resize"
      @mousedown="startResize"
      @dblclick="resetHeight"
      title="Drag to resize — double-click to reset"
    >
      <span class="panel-resize-grip" />
    </div>

    <button class="panel-close" @click="ui.closePanel()">✕</button>

    <div class="panel-meta" v-if="site" :class="{ hidden: expanded }">
      <div class="panel-title">{{ site.title_en }}</div>
      <div class="panel-desc" v-if="site.meta?.description">
        {{ site.meta.description }}
      </div>

      <div class="panel-rows">
        <div class="pm-row" v-if="site.country">
          <span class="pm-lbl">COUNTRY</span>
          <span class="pm-val">{{ site.country }}</span>
        </div>
        <div class="pm-row" v-if="inceptionStr">
          <span class="pm-lbl">FOUNDED</span>
          <span class="pm-val">{{ inceptionStr }}</span>
        </div>
        <div class="pm-row" v-if="dissolutionStr">
          <span class="pm-lbl">ABANDONED</span>
          <span class="pm-val">{{ dissolutionStr }}</span>
        </div>

        <template v-if="currentState">
          <div class="pm-divider" />
          <div class="pm-row" v-if="currentState.from">
            <span class="pm-lbl">PERIOD FROM</span>
            <span class="pm-val">{{ currentState.from }}</span>
          </div>
          <div class="pm-row" v-if="currentState.site_type">
            <span class="pm-lbl">TYPE</span>
            <span class="pm-val">{{ currentState.site_type }}</span>
          </div>
          <div class="pm-row" v-if="currentState.polity">
            <span class="pm-lbl">POLITY</span>
            <span class="pm-val">{{ currentState.polity }}</span>
          </div>
          <div class="pm-row" v-if="currentState.culture">
            <span class="pm-lbl">CULTURE</span>
            <span class="pm-val">{{ currentState.culture }}</span>
          </div>
          <div class="pm-row" v-if="currentState.name">
            <span class="pm-lbl">NAME</span>
            <span class="pm-val">{{ currentState.name }}</span>
          </div>
        </template>

        <!-- Pistes CO-OCCURRENTES : plusieurs entités vivantes à la fois. -->
        <template v-if="activeReligions.length">
          <div class="pm-divider" />
          <div class="pm-row pm-row--stack">
            <span class="pm-lbl">RELIGION</span>
            <div class="pm-multi">
              <span
                v-for="r in activeReligions"
                :key="r.key"
                class="pm-chip"
                :class="`pm-role-${r.role ?? 'unknown'}`"
                >{{ r.name }}</span
              >
            </div>
          </div>
        </template>

        <template v-if="activeLanguages.length">
          <div class="pm-row pm-row--stack">
            <span class="pm-lbl">LANGUAGE</span>
            <div class="pm-multi">
              <span
                v-for="l in activeLanguages"
                :key="l.key"
                class="pm-chip"
                :class="`pm-role-${l.role ?? 'unknown'}`"
                >{{ l.name }}</span
              >
            </div>
          </div>
        </template>
      </div>

      <div class="panel-tags">
        <span class="tag tag-polity" v-if="currentState?.polity">{{
          currentState.polity
        }}</span>
        <span class="tag tag-culture" v-if="currentState?.culture">{{
          currentState.culture
        }}</span>
      </div>

      <a
        :href="site.wikipedia_page_en_url"
        target="_blank"
        rel="noopener"
        class="panel-link"
      >
        → Wikipedia
      </a>
    </div>

    <div class="panel-timeline" v-if="site">
      <div class="timeline-header">
        <span class="timeline-title">HISTORICAL PERIODS</span>

        <div class="timeline-controls">
          <button
            class="tl-header-btn"
            :class="{ active: listView }"
            @click="listView = !listView"
            title="List view"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            >
              <line x1="1" y1="3" x2="13" y2="3" />
              <line x1="1" y1="7" x2="13" y2="7" />
              <line x1="1" y1="11" x2="13" y2="11" />
            </svg>
            <span>List</span>
          </button>

          <!-- Groupement de la vue liste : par dimension (défaut) ou chronologique pur.
               Par dimension, chaque piste se lit comme un récit continu ; en
               chronologique, on répond à « que se passait-il en 1453 ? ». -->
          <button
            v-if="listView"
            class="tl-header-btn"
            @click="
              listGrouping = listGrouping === 'track' ? 'chrono' : 'track'
            "
            :title="
              listGrouping === 'track'
                ? 'Grouped by dimension — click for pure chronological order'
                : 'Chronological order — click to group by dimension'
            "
          >
            <span>{{ listGrouping === "track" ? "By track" : "Chrono" }}</span>
          </button>
        </div>

        <span class="timeline-range">{{ timelineRange }}</span>
      </div>

      <TimelineTrack
        :site="site"
        :year="temporal.year"
        :listView="listView"
        :listGrouping="listGrouping"
        @update:listView="listView = $event"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted } from "vue";
import { useUIStore } from "../../stores/ui";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { useSiteDetailQuery } from "../../api/client";
import {
  getEntryAt,
  getActiveEntriesAt,
  getTimelineBounds,
  entityKey,
  formatYear,
  toStr,
} from "@strabon/shared";
import type { RoleQualifier } from "@strabon/shared";
import TimelineTrack from "./TimelineTrack.vue";

const ui = useUIStore();
const mapStore = useMapStore();
const temporal = useTemporalStore();

const listView = ref(false);
const listGrouping = ref<"track" | "chrono">("track");

// Le panel s'étend automatiquement en vue liste
const expanded = computed(() => listView.value);

// ── Hauteur du panneau, redimensionnable ─────────────────────────────────────
// Une hauteur fixe ne peut convenir à la fois à un site à 2 pistes et à un site
// dont la piste religion compte 8 couloirs. L'utilisateur arbitre.

const DEFAULT_H = 260;
const MIN_H = 140;
const STORAGE_KEY = "strabon.panelHeight";

function maxH(): number {
  return Math.max(MIN_H, window.innerHeight - 140);
}

function loadHeight(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  if (!Number.isFinite(raw) || raw < MIN_H) return DEFAULT_H;
  return Math.min(raw, maxH());
}

const panelHeight = ref(loadHeight());
const resizing = ref(false);

let startY = 0;
let startH = 0;

function startResize(e: MouseEvent) {
  resizing.value = true;
  startY = e.clientY;
  startH = panelHeight.value;
  // Le panneau est ancré en bas : tirer vers le HAUT l'agrandit.
  window.addEventListener("mousemove", onResize);
  window.addEventListener("mouseup", stopResize);
  e.preventDefault();
}

function onResize(e: MouseEvent) {
  const next = startH + (startY - e.clientY);
  panelHeight.value = Math.min(Math.max(next, MIN_H), maxH());
}

function stopResize() {
  resizing.value = false;
  localStorage.setItem(STORAGE_KEY, String(panelHeight.value));
  window.removeEventListener("mousemove", onResize);
  window.removeEventListener("mouseup", stopResize);
}

function resetHeight() {
  panelHeight.value = DEFAULT_H;
  localStorage.setItem(STORAGE_KEY, String(DEFAULT_H));
}

onUnmounted(() => {
  window.removeEventListener("mousemove", onResize);
  window.removeEventListener("mouseup", stopResize);
});

// ── Site ─────────────────────────────────────────────────────────────────────

const siteId = computed(() => mapStore.selectedSiteId);
const { data: site } = useSiteDetailQuery(siteId);

const inceptionStr = computed(() =>
  site.value ? formatYear(site.value.inception ?? null) : null,
);
const dissolutionStr = computed(() =>
  site.value ? formatYear(site.value.dissolution ?? null) : null,
);

const currentState = computed(() => {
  const s = site.value;
  if (!s?.timeline) return null;
  const tl = s.timeline;
  const y = temporal.year;

  const stEntry = getEntryAt(tl.site_type, y, { honorTo: true });
  const polEntry = getEntryAt(tl.polity, y, { honorTo: true });
  const culEntry = getEntryAt(tl.culture, y, { honorTo: true });
  const nameEntry = getEntryAt(tl.name, y, { honorTo: true });

  const activeTracks = [stEntry, polEntry, culEntry, nameEntry].filter(Boolean);
  if (!activeTracks.length) return null;

  const latestFrom = Math.max(...activeTracks.map((e) => e!.from));
  const latestEntry = activeTracks.find((e) => e!.from === latestFrom)!;

  return {
    from: formatYear({
      year: latestFrom,
      precision: latestEntry.from_precision ?? 9,
      circa: latestEntry.from_circa,
    }),
    site_type: stEntry ? toStr(stEntry.value).replace(/_/g, " ") : null,
    polity: polEntry ? toStr(polEntry.value) : null,
    culture: culEntry ? toStr(culEntry.value) : null,
    name: nameEntry
      ? `${(nameEntry.value as any).text ?? nameEntry.value}${(nameEntry.value as any).lang ? ` (${(nameEntry.value as any).lang})` : ""}`
      : null,
  };
});

// Religion et langue CO-OCCURRENT : à une année donnée, plusieurs entités sont
// vivantes. getActiveEntriesAt les rend toutes, triées state → minority.
type ActiveEntity = { key: string; name: string; role?: RoleQualifier };

function activeOn(track: any): ActiveEntity[] {
  return getActiveEntriesAt(track, temporal.year).map((e: any) => ({
    key: entityKey(e.value),
    name: toStr(e.value),
    role: e.role,
  }));
}

const activeReligions = computed<ActiveEntity[]>(() =>
  site.value?.timeline ? activeOn(site.value.timeline.religion) : [],
);
const activeLanguages = computed<ActiveEntity[]>(() =>
  site.value?.timeline ? activeOn(site.value.timeline.language) : [],
);

// getTimelineBounds parcourt TOUTES les pistes (via TRACK_KEYS) et tient compte
// des `to` — une religion éteinte en 1453 étend la plage même si aucune entrée
// `from` n'est plus récente. L'ancienne version itérait sur cinq pistes en dur et
// ignorait religion et language.
const timelineRange = computed(() => {
  const s = site.value;
  if (!s?.timeline) return "";
  const b = getTimelineBounds(s.timeline);
  if (!b) return "";
  const max = s.dissolution_year ?? new Date().getFullYear();
  const fmt = (y: number) => (y < 0 ? `${Math.abs(y)} BC` : `${y} AD`);
  return `${fmt(b.min)} → ${fmt(max)}`;
});
</script>

<style lang="scss" scoped>
.timeline-panel {
  flex: 0 0 var(--panel-h);
  background: var(--surface);
  border-top: 2px solid var(--border);
  display: flex;
  overflow: hidden;
  max-height: 0;
  border-top-width: 0;
  transition:
    max-height 0.3s ease,
    border-top-width 0.3s ease;
  position: relative;

  &.open {
    max-height: var(--panel-h);
    border-top-width: 2px;
  }

  // Mode expanded (vue liste) : prend toute la hauteur dispo sous le header
  &.open.expanded {
    max-height: calc(100vh - var(--header-h));
    flex-basis: calc(100vh - var(--header-h));
  }

  // Pendant le drag, aucune transition : le panneau doit suivre la souris.
  &.resizing {
    transition: none;
  }
}

// ── Poignée de redimensionnement ─────────────────────────────────────────────
.panel-resize {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover .panel-resize-grip,
  .timeline-panel.resizing & .panel-resize-grip {
    background: var(--accent);
    opacity: 0.9;
    width: 60px;
  }
}

.panel-resize-grip {
  width: 34px;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  opacity: 0.7;
  transition:
    background 0.15s,
    width 0.15s,
    opacity 0.15s;
  pointer-events: none;
}

.panel-close {
  position: absolute;
  right: 12px;
  top: 10px;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  z-index: 30;
  padding: 2px 6px;
  &:hover {
    color: var(--text);
  }
}

.panel-meta {
  flex: 0 0 230px;
  border-right: 1px solid var(--border);
  padding: 14px 14px 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  transition:
    flex-basis 0.3s ease,
    opacity 0.2s ease;

  &.hidden {
    flex: 0 0 0;
    opacity: 0;
    overflow: hidden;
    padding: 0;
  }

  &::-webkit-scrollbar {
    width: 8px;
  }
  &::-webkit-scrollbar-track {
    background: var(--bg);
    border-radius: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: #3a3e38;
    border-radius: 4px;
    border: 2px solid var(--bg);
  }
  &::-webkit-scrollbar-thumb:hover {
    background: #4a4e46;
  }
}

.panel-title {
  font-family: var(--font-head);
  font-size: 16px;
  color: var(--accent);
  letter-spacing: 0.08em;
}

.panel-desc {
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
  line-height: 1.4;
}

.pm-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  gap: 8px;
  align-items: baseline;

  // Les pistes co-occurrentes ont N valeurs : on empile sous le label.
  &--stack {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
  }
}

.pm-lbl {
  color: var(--muted);
  letter-spacing: 0.05em;
  flex-shrink: 0;
  font-size: 11px;
}

.pm-val {
  color: var(--text);
  text-align: right;
}

.pm-multi {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  justify-content: flex-end;
}

// Le rôle se lit à l'intensité, comme sur la frise.
.pm-chip {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 2px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.pm-role-state {
  background: hsla(280, 40%, 40%, 0.5);
  color: hsla(0, 0%, 100%, 0.95);
  border-color: rgba(255, 255, 255, 0.35);
}
.pm-role-major {
  background: hsla(280, 32%, 32%, 0.42);
  color: hsla(0, 0%, 100%, 0.85);
}
.pm-role-minor {
  background: hsla(280, 22%, 26%, 0.35);
  color: hsla(0, 0%, 100%, 0.72);
}
.pm-role-minority,
.pm-role-unknown {
  background: hsla(280, 14%, 22%, 0.3);
  color: hsla(0, 0%, 100%, 0.6);
  border: 1px dashed rgba(255, 255, 255, 0.18);
}

.pm-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.panel-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 2px;
}

.tag-polity {
  background: rgba(201, 168, 76, 0.1);
  color: var(--accent);
  border-color: rgba(201, 168, 76, 0.2);
}
.tag-culture {
  background: rgba(126, 184, 160, 0.1);
  color: var(--accent2);
  border-color: rgba(126, 184, 160, 0.2);
}

.panel-link {
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
  letter-spacing: 0.04em;
  margin-top: auto;
  padding-top: 4px;
  &:hover {
    text-decoration: underline;
  }
}

.panel-timeline {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px 14px 8px;
  overflow: hidden;
  min-width: 0;
}

.timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-shrink: 0;
}

.timeline-title {
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.timeline-controls {
  display: flex;
  gap: 4px;
}

.tl-header-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--muted);
  font-family: var(--font-body);
  font-size: 10px;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  cursor: pointer;
  transition:
    color 0.12s,
    border-color 0.12s,
    background 0.12s;

  &:hover {
    color: var(--text);
    border-color: var(--text);
  }

  &.active {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(201, 168, 76, 0.06);
  }
}

.timeline-range {
  font-size: 11px;
  color: var(--muted);
  opacity: 0.6;
  margin-left: auto;
}
</style>
