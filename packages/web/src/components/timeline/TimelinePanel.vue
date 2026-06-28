<template>
  <div
    class="timeline-panel"
    :class="{ open: ui.panelOpen, expanded: expanded }"
  >
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

        <!-- Contrôles de vue -->
        <div class="timeline-controls">
          <!-- Toggle vue liste -->
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
        </div>

        <span class="timeline-range">{{ timelineRange }}</span>
      </div>

      <TimelineTrack
        :site="site"
        :year="temporal.year"
        :listView="listView"
        @update:listView="listView = $event"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useUIStore } from "../../stores/ui";
import { useMapStore } from "../../stores/map";
import { useTemporalStore } from "../../stores/temporal";
import { useSiteDetailQuery } from "../../api/client";
import { getValueAt, getEntryAt, formatYear, toStr } from "@strabon/shared";
import TimelineTrack from "./TimelineTrack.vue";

const ui = useUIStore();
const mapStore = useMapStore();
const temporal = useTemporalStore();

const listView = ref(false);
// Le panel s'étend automatiquement en vue liste
const expanded = computed(() => listView.value);

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

  const stEntry = getEntryAt(tl.site_type, y);
  const polEntry = getEntryAt(tl.polity, y);
  const culEntry = getEntryAt(tl.culture, y);
  const nameEntry = getEntryAt(tl.name, y);

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

const timelineRange = computed(() => {
  const s = site.value;
  if (!s?.timeline) return "";
  const tl = s.timeline;
  const allFroms: number[] = [];
  for (const track of [
    tl.site_type,
    tl.polity,
    tl.culture,
    tl.name,
    tl.population,
  ]) {
    if (track?.entries) allFroms.push(...track.entries.map((e: any) => e.from));
  }
  if (!allFroms.length) return "";
  const min = Math.min(...allFroms);
  const max = s.dissolution_year ?? new Date().getFullYear();
  const fmt = (y: number) => (y < 0 ? `${Math.abs(y)} BC` : `${y} AD`);
  return `${fmt(min)} → ${fmt(max)}`;
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

  // Mode expanded : prend toute la hauteur dispo sous le header
  &.open.expanded {
    max-height: calc(100vh - var(--header-h));
    flex-basis: calc(100vh - var(--header-h));
  }
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
  z-index: 10;
  padding: 2px 6px;
  &:hover {
    color: var(--text);
  }
}

.panel-meta {
  flex: 0 0 230px;
  border-right: 1px solid var(--border);
  padding: 12px 14px;
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
  padding: 10px 14px 8px;
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
