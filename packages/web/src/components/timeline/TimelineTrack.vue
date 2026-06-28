<template>
  <div class="track-container">
    <!-- ── Header fixe (boutons toujours visibles) ───────────────────────── -->
    <div class="tl-axis-row">
      <div class="tl-axis-corner" ref="scaleWrap">
        <button
          v-if="!listView"
          class="tl-scale-btn"
          :class="{ active: scaleOpen }"
          @click.stop="scaleOpen = !scaleOpen"
          title="Time scale"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          >
            <path
              d="M1 12 Q4 4 7 8 Q10 12 13 2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <Transition name="tl-dropdown">
          <div v-if="scaleOpen && !listView" class="tl-scale-menu">
            <button
              v-for="(label, key) in ORDERED_SCALES"
              :key="key"
              class="tl-scale-item"
              :class="{ active: timeScale.mode.value === key }"
              @click="selectScale(key as ScaleMode)"
            >
              <span class="tl-scale-dot" />{{ label }}
            </button>
          </div>
        </Transition>
      </div>
      <!-- Axe temporel — masqué en vue liste -->
      <div
        v-if="!listView"
        class="tl-axis-wrap"
        :style="{ width: innerWidth + 'px' }"
      >
        <div class="tl-cursor-axis" :style="{ left: cursorPct + '%' }" />
        <div
          v-for="tick in ticks"
          :key="tick.year"
          class="tl-tick"
          :style="{ left: tick.pct + '%' }"
        >
          <div class="tl-tick-line" />
          <span>{{ tick.label }}</span>
        </div>
      </div>
    </div>
    <!-- end tl-axis-row -->

    <!-- ── Vue liste ──────────────────────────────────────────────────────── -->
    <div v-if="listView" class="tl-list-view">
      <div v-if="!listEntries.length" class="tl-list-empty">No data</div>
      <div
        v-for="(entry, i) in listEntries"
        :key="i"
        class="tl-list-entry"
        :class="{ 'tl-list-entry--event': entry.isEvent }"
      >
        <div class="tl-list-row">
          <span class="tl-list-from">{{ entry.fromLabel }}</span>
          <span
            class="tl-list-dim"
            :class="`tl-dim-${entry.dimension.toLowerCase()}`"
            >{{ entry.dimension }}</span
          >
          <span class="tl-list-value">{{ entry.value }}</span>
          <span
            v-if="entry.confidence"
            class="tl-list-conf"
            :class="`tl-conf-${entry.confidence}`"
            >{{ entry.confidence }}</span
          >
        </div>
        <div v-if="entry.notes" class="tl-list-meta">
          <span class="tl-list-meta-lbl">Notes</span> {{ entry.notes }}
        </div>
        <div v-if="entry.sources?.length" class="tl-list-meta">
          <span class="tl-list-meta-lbl">Sources</span>
          <span
            v-for="(src, si) in entry.sources"
            :key="si"
            class="tl-list-src"
            >{{ src }}</span
          >
        </div>
      </div>
    </div>

    <!-- ── Vue timeline ────────────────────────────────────────────────────── -->
    <div v-else class="track-scroll" ref="scrollEl">
      <!-- ── Rows : label sticky gauche + track scrollable ───────────────── -->
      <div v-for="row in activeRows" :key="row.key" class="tl-row">
        <span class="tl-row-label">{{ row.label }}</span>
        <div class="tl-row-track" :style="{ width: innerWidth + 'px' }">
          <div class="tl-cursor" :style="{ left: cursorPct + '%' }" />
          <div
            v-for="(block, i) in row.blocks"
            :key="i"
            class="tl-block"
            :class="{ active: block.isActive }"
            :style="{
              left: block.x + '%',
              width: block.w + '%',
              background: block.bg,
              color: block.fg,
            }"
            :data-row="row.key"
            @mouseenter="showTooltip($event, block)"
            @mouseleave="hideTooltip"
          >
            <span class="tl-block-text">{{ block.label }}</span>
          </div>
          <!-- Hiatus d'occupation (zone vide) -->
          <div
            v-for="(gap, gi) in row.gaps"
            :key="'gap-' + gi"
            class="tl-gap"
            :style="{ left: gap.x + '%', width: gap.w + '%' }"
            :title="gap.title"
          />
        </div>
      </div>

      <!-- ── Ligne EVENTS ─────────────────────────────────────────────────── -->
      <div v-if="events.length" class="tl-row">
        <span class="tl-row-label">EVENTS</span>
        <div
          class="tl-row-track tl-row-track--events"
          :style="{ width: innerWidth + 'px' }"
        >
          <div
            v-for="ev in events"
            :key="ev.year"
            class="tl-event"
            :style="{ left: xPct(ev.year) + '%' }"
            @mouseenter="showTooltip($event, ev)"
            @mouseleave="hideTooltip"
          >
            {{ ev.icon }}
          </div>
        </div>
      </div>
    </div>
    <!-- end track-scroll -->

    <!-- Tooltip -->
    <Teleport to="body">
      <div
        v-if="tooltip.visible"
        class="tl-tooltip"
        :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
      >
        <div class="tl-tt-row" v-if="tooltip.from">
          <span class="tl-tt-lbl">FROM</span>
          <span class="tl-tt-val">{{ tooltip.from }}</span>
        </div>
        <div class="tl-tt-row" v-if="tooltip.value">
          <span class="tl-tt-lbl">{{ tooltip.rowLabel }}</span>
          <span class="tl-tt-val accent">{{ tooltip.value }}</span>
        </div>
        <div class="tl-tt-notes" v-if="tooltip.notes">{{ tooltip.notes }}</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  ref,
  watch,
  nextTick,
  reactive,
  onMounted,
  onUnmounted,
} from "vue";
import { getEntryAt, formatYear, SCALE_LABELS } from "@strabon/shared";
import type { SiteTimeline, EventType, ScaleMode } from "@strabon/shared";
import { useTimeScale } from "../../composables/useTimeScale";

const props = defineProps<{
  site: any;
  year: number;
  listView?: boolean;
}>();

const emit = defineEmits<{ "update:listView": [value: boolean] }>();

const scrollEl = ref<HTMLDivElement>();
const timeScale = useTimeScale();
const scaleWrap = ref<HTMLElement>();
const scaleOpen = ref(false);

// Ordre et libellés anglais pour le menu d'échelle
const ORDERED_SCALES: Record<string, string> = {
  linear: "Linear",
  sqrt: "Square root",
  log: "Logarithmic",
};

function selectScale(mode: ScaleMode) {
  timeScale.setMode(mode);
  scaleOpen.value = false;
}

function onScaleClickOutside(e: MouseEvent) {
  if (scaleWrap.value && !scaleWrap.value.contains(e.target as Node))
    scaleOpen.value = false;
}

// ── Vue liste (contrôlée par TimelinePanel) ──────────────────────────────────

type ListEntry = {
  from: number;
  fromLabel: string;
  dimension: string;
  value: string;
  confidence?: string;
  notes?: string;
  sources?: string[];
  isEvent?: boolean;
  eventType?: string;
};

const listEntries = computed((): ListEntry[] => {
  const tl: SiteTimeline = props.site?.timeline;
  if (!tl) return [];
  const result: ListEntry[] = [];

  const DIMS = [
    {
      key: "site_type",
      label: "TYPE",
      track: tl.site_type,
      fmt: (v: any) => String(v).replace(/_/g, " "),
    },
    {
      key: "polity",
      label: "POLITY",
      track: tl.polity,
      fmt: (v: any) => v?.name ?? String(v),
    },
    {
      key: "culture",
      label: "CULTURE",
      track: tl.culture,
      fmt: (v: any) => v?.name ?? String(v),
    },
    {
      key: "name",
      label: "NAME",
      track: tl.name,
      fmt: (v: any) =>
        v?.text ? `${v.text}${v.lang ? ` (${v.lang})` : ""}` : String(v),
    },
    {
      key: "population",
      label: "POP.",
      track: tl.population,
      fmt: (v: any) => Number(v).toLocaleString(),
    },
  ];

  for (const dim of DIMS) {
    for (const e of dim.track?.entries ?? []) {
      result.push({
        from: e.from,
        fromLabel:
          formatYear({
            year: e.from,
            precision: e.from_precision ?? 9,
            circa: e.from_circa,
          }) ?? String(e.from),
        dimension: dim.label,
        value: dim.fmt(e.value),
        confidence: (e as any).confidence,
        notes: (e as any).notes,
        sources: (e as any).sources,
      });
    }
  }

  // Événements
  for (const ev of tl.events ?? []) {
    result.push({
      from: ev.year,
      fromLabel:
        formatYear({
          year: ev.year,
          precision: ev.year_precision ?? 9,
          circa: ev.year_circa,
        }) ?? String(ev.year),
      dimension: "EVENT",
      value: `${ev.type}${ev.perpetrator ? ` — ${ev.perpetrator}` : ""}`,
      confidence: ev.confidence,
      notes: ev.description,
      sources: undefined,
      isEvent: true,
      eventType: ev.type,
    });
  }

  return result.sort((a, b) => a.from - b.from);
});

onMounted(() => document.addEventListener("click", onScaleClickOutside));
onUnmounted(() => document.removeEventListener("click", onScaleClickOutside));

// ── Plage temporelle ──────────────────────────────────────────────────────────
const tlRange = computed(() => {
  const tl: SiteTimeline = props.site?.timeline;
  if (!tl) return { min: -1000, max: 2000 };
  const froms: number[] = [];
  for (const track of [
    tl.site_type,
    tl.polity,
    tl.culture,
    tl.name,
    tl.population,
  ]) {
    if (track?.entries) froms.push(...track.entries.map((e) => e.from));
  }
  if (tl.events) froms.push(...tl.events.map((e) => e.year));
  if (!froms.length) return { min: -1000, max: 2000 };
  const dataMin = Math.min(...froms);
  // Les `to` (fins d'occupation, piste site_type) doivent étendre la plage,
  // sinon un hiatus/dissolution déborde à droite en preview tant que
  // dissolution_year n'est pas recalculé en base.
  const tos = (tl.site_type?.entries ?? [])
    .map((e) => e.to)
    .filter((t): t is number => t != null);
  const dataMax = Math.max(
    props.site?.dissolution_year ?? -Infinity,
    ...froms,
    ...tos,
  );
  const span = Math.max(dataMax - dataMin, 100);
  return { min: dataMin - span * 0.04, max: dataMax + span * 0.04 };
});

// xPct utilise l'échelle choisie (sqrt, log, linear).
// Le void force la dépendance réactive pour que les computed appelant xPct
// se recalculent quand le mode change.
function xPct(year: number): number {
  void timeScale.mode.value;
  return timeScale.xPct(year, tlRange.value.min, tlRange.value.max);
}

// ── Largeur du conteneur interne ─────────────────────────────────────────────
const innerWidth = computed(() => {
  const tl: SiteTimeline = props.site?.timeline;
  if (!tl) return 600;
  const maxEntries = Math.max(
    ...[tl.site_type, tl.polity, tl.culture, tl.name, tl.population]
      .filter(Boolean)
      .map((t) => t!.entries.length),
    1,
  );
  const scrollW = scrollEl.value?.clientWidth ?? 600;
  // On soustrait la largeur des labels pour le calcul
  return Math.max(scrollW - LABEL_W, maxEntries * 65);
});

// Largeur des labels (doit correspondre au CSS)
const LABEL_W = 52;

// ── Curseur ───────────────────────────────────────────────────────────────────
const cursorPct = computed(() => xPct(props.year));

// ── Couleurs utilitaires ──────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  capital: "#c9a84c",
  capital_city: "#c9a84c",
  metropolis: "#3a4aaa",
  city: "#4a6aaa",
  town: "#4a7a8a",
  village: "#5c7a5a",
  settlement: "#7a6e52",
  campsite: "#6b5e7a",
  ruins: "#5a5a5a",
  abandoned: "#3a3a3a",
  fortress: "#7a4a3a",
  port: "#3a8aaa",
  religious_site: "#aa6a4a",
  colony: "#6a8a4a",
  administrative: "#8a7a5a",
};

function strHue(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}
function strBg(s: string, alpha = 0.55): string {
  return `hsla(${strHue(s)},40%,38%,${alpha})`;
}
function strFg(s: string): string {
  return `hsl(${strHue(s)},60%,75%)`;
}

// ── Construction des lignes ───────────────────────────────────────────────────
type Block = {
  x: number;
  w: number;
  bg: string;
  fg: string;
  label: string;
  isActive: boolean;
  from: number;
  fromPrecision: number;
  fromCirca?: boolean;
  notes?: string;
  confidence?: string;
  rowLabel: string;
};

// Trou d'occupation (hiatus) rendu comme zone vide hachurée.
type Gap = { x: number; w: number; title: string };

function fmtY(year: number): string {
  return formatYear({ year, precision: 9 }) ?? String(year);
}

const ROWS = [
  {
    key: "site_type",
    label: "TYPE",
    trackFn: (tl: SiteTimeline) => tl.site_type,
    colorFn: (v: any) => TYPE_COLORS[v] ?? "#6b6b5a",
    fgFn: () => "rgba(255,255,255,.85)",
    labelFn: (v: any) => String(v).replace("_", " "),
    activeFn: (v: any, tl: SiteTimeline, year: number) =>
      v === getEntryAt(tl.site_type, year)?.value,
  },
  {
    key: "polity",
    label: "POLITY",
    trackFn: (tl: SiteTimeline) => tl.polity,
    colorFn: (v: any) => strBg(v.name),
    fgFn: (v: any) => strFg(v.name),
    labelFn: (v: any) => v.name,
    activeFn: (v: any, tl: SiteTimeline, year: number) =>
      v.name === getEntryAt(tl.polity, year)?.value?.name,
  },
  {
    key: "culture",
    label: "CULTURE",
    trackFn: (tl: SiteTimeline) => tl.culture,
    colorFn: (v: any) => strBg(v.name),
    fgFn: (v: any) => strFg(v.name),
    labelFn: (v: any) => v.name,
    activeFn: (v: any, tl: SiteTimeline, year: number) =>
      v.name === getEntryAt(tl.culture, year)?.value?.name,
  },
  {
    key: "name",
    label: "NAME",
    trackFn: (tl: SiteTimeline) => tl.name,
    colorFn: (v: any) => strBg(v.text, 0.42),
    fgFn: (v: any) => strFg(v.text),
    labelFn: (v: any) => `${v.text}${v.lang ? ` (${v.lang})` : ""}`,
    activeFn: (v: any, tl: SiteTimeline, year: number) =>
      v.text === getEntryAt(tl.name, year)?.value?.text,
  },
  {
    key: "population",
    label: "POP.",
    trackFn: (tl: SiteTimeline) => tl.population,
    colorFn: () => strBg("population", 0.42),
    fgFn: () => strFg("population"),
    labelFn: (v: any) => Number(v).toLocaleString(),
    activeFn: (v: any, tl: SiteTimeline, year: number) =>
      v === getEntryAt(tl.population, year)?.value,
  },
];

const activeRows = computed(() => {
  const tl: SiteTimeline = props.site?.timeline;
  if (!tl) return [];
  const dissolve = props.site?.dissolution_year ?? tlRange.value.max;

  return ROWS.filter((row) => row.trackFn(tl)?.entries?.length).map((row) => {
    const entries = [...(row.trackFn(tl)?.entries ?? [])].sort(
      (a, b) => a.from - b.from,
    );
    const blocks: Block[] = [];
    const gaps: Gap[] = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const nextFrom = i < entries.length - 1 ? entries[i + 1].from : dissolve;
      // `to` explicite (site_type uniquement) ⇒ fin d'occupation : le bloc
      // s'arrête à `to` et un hiatus court jusqu'à l'entrée suivante.
      // Sans `to`, l'entrée s'étend jusqu'à la suivante (comportement historique).
      const closeAt = e.to != null ? e.to : nextFrom;
      const x = xPct(e.from);
      const w = xPct(closeAt) - x;

      if (w > 0) {
        blocks.push({
          x,
          w,
          bg: row.colorFn(e.value),
          fg: row.fgFn(e.value),
          label: row.labelFn(e.value),
          // Pendant un hiatus, le bloc qui a fermé ne doit pas rester surligné.
          isActive:
            row.activeFn(e.value, tl, props.year) &&
            !(e.to != null && props.year > e.to),
          from: e.from,
          fromPrecision: e.from_precision ?? 9,
          fromCirca: e.from_circa,
          notes: e.notes,
          confidence: e.confidence,
          rowLabel: row.label,
        });
      }

      // Hiatus : trou entre la fin d'occupation (to) et la reprise (next.from).
      if (e.to != null && e.to < nextFrom) {
        const gx = xPct(e.to);
        const gw = xPct(nextFrom) - gx;
        if (gw > 0) {
          gaps.push({
            x: gx,
            w: gw,
            title: `Hiatus — ${fmtY(e.to)} → ${fmtY(nextFrom)}`,
          });
        }
      }
    }
    return { key: row.key, label: row.label, blocks, gaps };
  });
});

// ── Événements ponctuels ─────────────────────────────────────────────────────
const EVENT_ICONS: Record<EventType, string> = {
  destruction: "💥",
  fire: "🔥",
  earthquake: "🌊",
  flood: "🌊",
  plague: "☠",
  siege: "⚔",
  conquest: "⚔",
  founding: "✦",
  refounding: "✦",
  abandonment: "→",
  expulsion: "→",
  depopulation: "↓",
};

const events = computed(() => {
  const tl: SiteTimeline = props.site?.timeline;
  if (!tl?.events) return [];
  return tl.events
    .filter((e) => {
      const x = xPct(e.year);
      return x >= 0 && x <= 100;
    })
    .map((e) => ({
      year: e.year,
      from: e.year,
      fromPrecision: e.year_precision ?? 9,
      fromCirca: e.year_circa,
      icon: EVENT_ICONS[e.type] ?? "●",
      label: `${e.type}${e.perpetrator ? " — " + e.perpetrator : ""}`,
      notes: e.description,
      rowLabel: "EVENT",
    }));
});

// ── Ticks d'axe ───────────────────────────────────────────────────────────────
const ticks = computed(() => {
  const { min, max } = tlRange.value;
  const span = max - min;
  const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const step = steps.find((s) => innerWidth.value / (span / s) >= 50) ?? 10000;
  const start = Math.ceil(min / step) * step;
  const result = [];
  for (let y = start; y <= max; y += step) {
    const abs = Math.abs(y);
    const label =
      y < 0
        ? abs >= 1000
          ? `${Math.round(abs / 100) / 10}k BC`
          : `${abs} BC`
        : `${y} AD`;
    result.push({ year: y, pct: xPct(y), label });
  }
  return result;
});

// ── Scroll vers l'année courante à l'ouverture ────────────────────────────────
async function scrollToCursor() {
  await nextTick();
  if (!scrollEl.value) return;

  // Attendre que le conteneur soit dimensionné
  if (scrollEl.value.clientWidth === 0) {
    await new Promise<void>((resolve) => {
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        resolve();
      });
      ro.observe(scrollEl.value!);
    });
    await nextTick();
  }

  const cx = (cursorPct.value / 100) * innerWidth.value;
  scrollEl.value.scrollLeft = Math.max(0, cx - scrollEl.value.clientWidth / 2);
}

watch(() => props.site, scrollToCursor);

// Rescroller aussi quand l'échelle change (les positions px changent)
watch(() => timeScale.mode.value, scrollToCursor);

// ── Tooltip ───────────────────────────────────────────────────────────────────
const tooltip = reactive({
  visible: false,
  x: 0,
  y: 0,
  from: "",
  rowLabel: "",
  value: "",
  notes: "",
});

function showTooltip(event: MouseEvent, data: any) {
  const fromStr = formatYear({
    year: data.from,
    precision: data.fromPrecision ?? data.year_precision ?? 9,
    circa: data.fromCirca ?? data.year_circa,
  });
  tooltip.from = fromStr ?? "";
  tooltip.rowLabel = data.rowLabel ?? "";
  tooltip.value = data.label ?? "";
  tooltip.notes = data.notes ?? "";
  tooltip.visible = true;
  moveTooltip(event);
}

function hideTooltip() {
  tooltip.visible = false;
}

function moveTooltip(event: MouseEvent) {
  let x = event.clientX + 14;
  let y = event.clientY - 10;
  if (x + 250 > window.innerWidth) x = event.clientX - 260;
  if (y + 150 > window.innerHeight) y = event.clientY - 150;
  tooltip.x = x;
  tooltip.y = y;
}

document.addEventListener("mousemove", (e) => {
  if (tooltip.visible) moveTooltip(e as MouseEvent);
});
</script>

<style lang="scss" scoped>
// Largeur fixe des labels — doit correspondre à LABEL_W dans le script
$label-w: 52px;

.track-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

// Zone de scroll unique : horizontal + vertical
.track-scroll {
  flex: 1;
  overflow: auto;
  position: relative;
  min-height: 0;

  &::-webkit-scrollbar {
    width: 6px;
    height: 6px;
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
  // Coin scrollbar (intersection H + V)
  &::-webkit-scrollbar-corner {
    background: var(--bg);
  }
}

// ── Ligne axe temporel (sticky top) ──────────────────────────────────────────
.tl-axis-row {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  height: 26px;
  flex-shrink: 0;
}

// Coin en haut à gauche (sticky top + sticky left)
.tl-axis-corner {
  width: $label-w;
  flex-shrink: 0;
  position: sticky;
  left: 0;
  z-index: 30;
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
}

.tl-scale-btn {
  width: 100%;
  height: 100%;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  transition:
    opacity 0.15s,
    color 0.15s;

  &:hover,
  &.active {
    opacity: 1;
    color: var(--accent);
  }
}

.tl-scale-menu {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
  z-index: 100;
  min-width: 150px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
}

.tl-scale-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  padding: 7px 10px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  letter-spacing: 0.04em;
  transition:
    color 0.12s,
    background 0.12s;

  &:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.04);
  }
  &.active {
    color: var(--accent);
    .tl-scale-dot {
      background: var(--accent);
      border-color: var(--accent);
    }
  }
}

.tl-scale-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  border: 1px solid var(--muted);
  flex-shrink: 0;
}

.tl-dropdown-enter-active,
.tl-dropdown-leave-active {
  transition:
    opacity 0.12s,
    transform 0.12s;
}
.tl-dropdown-enter-from,
.tl-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

// Zone de l'axe (défile horizontalement avec les tracks)
.tl-axis-wrap {
  position: relative;
  height: 100%;
  flex-shrink: 0;
}

// Curseur dans l'axe
.tl-cursor-axis {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--accent);
  opacity: 0.6;
  pointer-events: none;
  z-index: 6;
}

// ── Rows ──────────────────────────────────────────────────────────────────────
.tl-row {
  display: flex;
  align-items: center;
  height: 32px;
  margin-bottom: 4px;
  position: relative;
}

// Label sticky à gauche
.tl-row-label {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.05em;
  width: $label-w;
  flex-shrink: 0;
  text-align: right;
  padding-right: 7px;
  white-space: nowrap;
  position: sticky;
  left: 0;
  z-index: 10;
  background: var(--surface);
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  // Petit dégradé pour masquer proprement les blocs qui passent dessous
  &::after {
    content: "";
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 8px;
    background: linear-gradient(to right, transparent, var(--surface));
    pointer-events: none;
  }
}

// Zone des blocs (largeur dynamique, défile)
.tl-row-track {
  flex-shrink: 0;
  position: relative;
  height: 22px;

  &--events {
    overflow: visible;
  }
}

// Curseur sur chaque row
.tl-cursor {
  position: absolute;
  top: -5px;
  bottom: -5px;
  width: 1.5px;
  background: var(--accent);
  opacity: 0.8;
  pointer-events: none;
  z-index: 6;

  &::before {
    content: "";
    position: absolute;
    top: 5px;
    left: -4px;
    width: 9px;
    height: 9px;
    background: var(--accent);
    border-radius: 50%;
  }
}

.tl-block {
  position: absolute;
  height: 100%;
  border-radius: 2px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  display: flex;
  align-items: center;
  padding: 0 6px;
  font-size: 11px;
  transition:
    filter 0.15s,
    opacity 0.15s;

  &:hover {
    filter: brightness(1.3);
    z-index: 10;
  }
  &.active {
    outline: 1.5px solid rgba(255, 255, 255, 0.5);
    z-index: 5;
  }
}

.tl-block-text {
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

// Hiatus d'occupation : trou hachuré entre deux périodes d'occupation
.tl-gap {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
  box-sizing: border-box;
  pointer-events: auto;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.06),
    rgba(255, 255, 255, 0.06) 4px,
    transparent 4px,
    transparent 8px
  );
  border: 1px dashed rgba(255, 255, 255, 0.14);
}

.tl-event {
  position: absolute;
  transform: translateX(-50%);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;

  &:hover {
    z-index: 10;
  }
}

// ── Ticks ────────────────────────────────────────────────────────────────────
.tl-tick {
  position: absolute;
  font-size: 10px;
  color: var(--muted);
  transform: translateX(-50%);
  white-space: nowrap;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.tl-tick-line {
  width: 1px;
  height: 4px;
  background: var(--border);
  margin-bottom: 2px;
}

// ── Vue liste ──────────────────────────────────────────────────────────────────
.tl-list-view {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  font-family: var(--font-body);
  font-size: 18px;

  &::-webkit-scrollbar {
    width: 5px;
  }
  &::-webkit-scrollbar-thumb {
    background: #3a3e38;
    border-radius: 3px;
  }
}

.tl-list-empty {
  color: var(--muted);
  padding: 8px;
  font-size: 18px;
}

.tl-list-entry {
  padding: 5px 0;
  border-bottom: 1px solid var(--border);

  &--event {
    background: rgba(255, 255, 255, 0.02);
  }
  &:last-child {
    border-bottom: none;
  }
}

.tl-list-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.tl-list-from {
  font-size: 17px;
  color: var(--muted);
  min-width: 110px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.tl-list-dim {
  font-size: 14px;
  letter-spacing: 0.07em;
  min-width: 68px;
  flex-shrink: 0;
  opacity: 0.7;
}
.tl-dim-type {
  color: #c9a84c;
}
.tl-dim-polity {
  color: #7eb8a0;
}
.tl-dim-culture {
  color: #a07eb8;
}
.tl-dim-name {
  color: #7e9eb8;
}
.tl-dim-pop\. {
  color: #b87e7e;
}
.tl-dim-event {
  color: #b8a07e;
}

.tl-list-value {
  flex: 1;
  color: var(--text);
  font-size: 18px;
}

.tl-list-conf {
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 2px;
  flex-shrink: 0;
}
.tl-conf-high {
  color: #5a9a6a;
  border: 1px solid #3a6a4a;
}
.tl-conf-medium {
  color: #9a8a4a;
  border: 1px solid #6a5a2a;
}
.tl-conf-low {
  color: #9a5a4a;
  border: 1px solid #6a3a2a;
}

.tl-list-meta {
  margin-top: 3px;
  padding-left: 120px;
  font-size: 17px;
  color: var(--muted);
  font-style: italic;
  line-height: 1.4;
}

.tl-list-meta-lbl {
  font-style: normal;
  font-size: 14px;
  letter-spacing: 0.06em;
  color: var(--muted);
  opacity: 0.6;
  margin-right: 4px;
  text-transform: uppercase;
}

.tl-list-src {
  display: block;
  padding-left: 8px;
  &::before {
    content: '"';
  }
  &::after {
    content: '"';
  }
}
</style>
