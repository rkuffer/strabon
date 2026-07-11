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
          <span class="tl-list-dim" :class="`tl-dim-${entry.trackKey}`">{{
            entry.dimension
          }}</span>
          <span class="tl-list-value">{{ entry.value }}</span>
          <span
            v-if="entry.role"
            class="tl-list-role"
            :class="`tl-role-${entry.role}`"
            >{{ entry.role }}</span
          >
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

      <!-- Lacunes du référentiel signalées par l'extraction -->
      <div v-if="missingEntities.length" class="tl-missing">
        <div class="tl-missing-title">
          Referential gaps signalled by extraction
        </div>
        <div v-for="(m, i) in missingEntities" :key="i" class="tl-missing-row">
          <span class="tl-list-dim" :class="`tl-dim-${m.kind}`">{{
            m.kind.toUpperCase()
          }}</span>
          <span class="tl-missing-name">{{ m.name }}</span>
          <span v-if="m.proposed_qid" class="tl-missing-qid">{{
            m.proposed_qid
          }}</span>
          <span v-if="m.context" class="tl-missing-ctx">{{ m.context }}</span>
        </div>
      </div>
    </div>

    <!-- ── Vue timeline ────────────────────────────────────────────────────── -->
    <div v-else class="track-scroll" ref="scrollEl">
      <div
        v-for="row in rows"
        :key="row.key"
        class="tl-row"
        :class="{ 'tl-row--lanes': row.kind === 'lanes' }"
      >
        <span class="tl-row-label">{{ row.label }}</span>

        <!-- ── Piste ESCALIER : une seule ligne de blocs ─────────────────── -->
        <div
          v-if="row.kind === 'step'"
          class="tl-row-track"
          :style="{ width: innerWidth + 'px' }"
        >
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

        <!-- ── Piste CO-OCCURRENTE : N couloirs empilés ──────────────────── -->
        <div v-else class="tl-lanes" :style="{ width: innerWidth + 'px' }">
          <div
            class="tl-cursor tl-cursor--lanes"
            :style="{ left: cursorPct + '%' }"
          />
          <div v-for="lane in row.lanes" :key="lane.key" class="tl-lane">
            <div
              v-for="(seg, si) in lane.segments"
              :key="si"
              class="tl-seg"
              :class="[
                `tl-seg--${seg.role ?? 'unknown'}`,
                { active: seg.isActive, open: seg.open },
              ]"
              :style="{
                left: seg.x + '%',
                width: seg.w + '%',
                background: seg.bg,
                color: seg.fg,
              }"
              @mouseenter="showTooltip($event, seg)"
              @mouseleave="hideTooltip"
            >
              <span class="tl-block-text">{{ seg.label }}</span>
            </div>
          </div>
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

    <!-- Tooltip -->
    <Teleport to="body">
      <div
        v-if="tooltip.visible"
        class="tl-tooltip"
        :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
      >
        <div class="tl-tt-row" v-if="tooltip.period">
          <span class="tl-tt-lbl">PERIOD</span>
          <span class="tl-tt-val">{{ tooltip.period }}</span>
        </div>
        <div class="tl-tt-row" v-if="tooltip.value">
          <span class="tl-tt-lbl">{{ tooltip.rowLabel }}</span>
          <span class="tl-tt-val accent">{{ tooltip.value }}</span>
        </div>
        <div class="tl-tt-row" v-if="tooltip.role">
          <span class="tl-tt-lbl">ROLE</span>
          <span class="tl-tt-val">{{ tooltip.role }}</span>
        </div>
        <div class="tl-tt-row" v-if="tooltip.confidence">
          <span class="tl-tt-lbl">CONF.</span>
          <span class="tl-tt-val">{{ tooltip.confidence }}</span>
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
import {
  getEntryAt,
  getActiveEntriesAt,
  buildLanes,
  getTimelineBounds,
  getTrack,
  presentTrackKeys,
  entityKey,
  formatYear,
  formatTrackEntry,
  TRACK_META,
  isCooccurrent,
} from "@strabon/shared";
import type {
  SiteTimeline,
  EventType,
  ScaleMode,
  TrackKey,
  TrackEntry,
  RoleQualifier,
  MissingEntity,
} from "@strabon/shared";
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

onMounted(() => document.addEventListener("click", onScaleClickOutside));
onUnmounted(() => document.removeEventListener("click", onScaleClickOutside));

const timeline = computed<SiteTimeline | undefined>(
  () => props.site?.timeline ?? undefined,
);

// ── Plage temporelle ──────────────────────────────────────────────────────────
// getTimelineBounds tient compte des `to` de TOUTES les pistes — une religion
// éteinte en 1453 étend la frise même si aucune entrée `from` n'est plus récente.

const dataBounds = computed(() => {
  const b = getTimelineBounds(timeline.value);
  if (!b) return { min: -1000, max: 2000 };
  const max = Math.max(b.max, props.site?.dissolution_year ?? -Infinity);
  return { min: b.min, max };
});

// Borne droite utilisée pour fermer les segments encore ouverts.
const endYear = computed(() => dataBounds.value.max);

const tlRange = computed(() => {
  const { min, max } = dataBounds.value;
  const span = Math.max(max - min, 100);
  return { min: min - span * 0.04, max: max + span * 0.04 };
});

// xPct utilise l'échelle choisie (sqrt, log, linear). Le void force la dépendance
// réactive pour que les computed appelant xPct se recalculent au changement de mode.
function xPct(year: number): number {
  void timeScale.mode.value;
  return timeScale.xPct(year, tlRange.value.min, tlRange.value.max);
}

// ── Largeur du conteneur interne ─────────────────────────────────────────────
const LABEL_W = 62;

const innerWidth = computed(() => {
  const tl = timeline.value;
  if (!tl) return 600;
  const counts = presentTrackKeys(tl).map(
    (k) => getTrack(tl, k)?.entries.length ?? 0,
  );
  const maxEntries = Math.max(...counts, 1);
  const scrollW = scrollEl.value?.clientWidth ?? 600;
  return Math.max(scrollW - LABEL_W, maxEntries * 65);
});

const cursorPct = computed(() => xPct(props.year));

// ── Couleurs ──────────────────────────────────────────────────────────────────
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

// Le RÔLE est rendu par l'opacité du fond : plus l'entité est dominante, plus le
// bloc est franc. La bordure (CSS) complète la lecture.
const ROLE_ALPHA: Record<RoleQualifier | "unknown", number> = {
  state: 0.72,
  major: 0.5,
  minor: 0.32,
  minority: 0.2,
  unknown: 0.4,
};

// ── Construction des lignes ───────────────────────────────────────────────────

type Block = {
  x: number;
  w: number;
  bg: string;
  fg: string;
  label: string;
  isActive: boolean;
  open?: boolean;
  role?: RoleQualifier;
  from: number;
  to?: number | null;
  fromPrecision: number;
  fromCirca?: boolean;
  notes?: string;
  confidence?: string;
  rowLabel: string;
};

type Gap = { x: number; w: number; title: string };

type StepRow = {
  kind: "step";
  key: TrackKey;
  label: string;
  blocks: Block[];
  gaps: Gap[];
};

type LaneRow = {
  kind: "lanes";
  key: TrackKey;
  label: string;
  lanes: { key: string; segments: Block[] }[];
};

function fmtY(year: number): string {
  return formatYear({ year, precision: 9 }) ?? String(year);
}

function periodLabel(
  from: number,
  to: number | null | undefined,
  open?: boolean,
): string {
  if (open || to == null) return `${fmtY(from)} → …`;
  return `${fmtY(from)} → ${fmtY(to)}`;
}

// Couleur/libellé selon la piste — les pistes escalier gardent leur rendu d'origine.
function blockBg(key: TrackKey, v: any, role?: RoleQualifier): string {
  if (key === "site_type") return TYPE_COLORS[v] ?? "#6b6b5a";
  if (key === "population") return strBg("population", 0.42);
  if (key === "name") return strBg(v.text, 0.42);
  const seed = v?.name ?? String(v);
  if (isCooccurrent(key)) return strBg(seed, ROLE_ALPHA[role ?? "unknown"]);
  return strBg(seed);
}

function blockFg(key: TrackKey, v: any): string {
  if (key === "site_type") return "rgba(255,255,255,.85)";
  if (key === "population") return strFg("population");
  if (key === "name") return strFg(v.text);
  return strFg(v?.name ?? String(v));
}

const rows = computed<(StepRow | LaneRow)[]>(() => {
  const tl = timeline.value;
  if (!tl) return [];
  const end = endYear.value;

  return presentTrackKeys(tl).map((key) => {
    const meta = TRACK_META[key];
    const track = getTrack(tl, key)!;

    // ── Pistes CO-OCCURRENTES : couloirs ─────────────────────────────────────
    if (isCooccurrent(key)) {
      // Entités vivantes à l'année courante — sert au surlignage.
      const activeKeys = new Set(
        getActiveEntriesAt(track, props.year).map((e) => entityKey(e.value)),
      );

      const lanes = buildLanes(track, end).map((lane) => ({
        key: lane.key,
        segments: lane.segments
          .map((seg): Block | null => {
            const x = xPct(seg.from);
            const w = xPct(seg.to) - x;
            if (w <= 0) return null;
            const e = seg.entry as TrackEntry<any>;
            return {
              x,
              w,
              bg: blockBg(key, e.value, seg.role),
              fg: blockFg(key, e.value),
              label: lane.label,
              isActive:
                activeKeys.has(lane.key) &&
                seg.from <= props.year &&
                props.year <= seg.to,
              open: seg.open,
              role: seg.role,
              from: seg.from,
              to: seg.open ? null : seg.to,
              fromPrecision: e.from_precision ?? 9,
              fromCirca: e.from_circa,
              notes: e.notes,
              confidence: e.confidence,
              rowLabel: meta.label,
            };
          })
          .filter((b): b is Block => b !== null),
      }));

      return {
        kind: "lanes",
        key,
        label: meta.label,
        lanes: lanes.filter((l) => l.segments.length),
      } satisfies LaneRow;
    }

    // ── Pistes ESCALIER (et site_type avec hiatus) ───────────────────────────
    const entries = [...track.entries].sort((a, b) => a.from - b.from);
    const activeEntry = getEntryAt(track, props.year);
    const blocks: Block[] = [];
    const gaps: Gap[] = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const nextFrom = i < entries.length - 1 ? entries[i + 1].from : end;
      // `to` explicite (site_type) ⇒ fin d'occupation : le bloc s'arrête à `to`
      // et un hiatus court jusqu'à l'entrée suivante.
      const closeAt = e.to != null ? e.to : nextFrom;
      const x = xPct(e.from);
      const w = xPct(closeAt) - x;

      if (w > 0) {
        blocks.push({
          x,
          w,
          bg: blockBg(key, e.value),
          fg: blockFg(key, e.value),
          label: formatTrackEntry(key, e),
          // Pendant un hiatus, le bloc qui a fermé ne doit pas rester surligné.
          isActive: activeEntry === e && !(e.to != null && props.year > e.to),
          from: e.from,
          to: closeAt,
          fromPrecision: e.from_precision ?? 9,
          fromCirca: e.from_circa,
          notes: e.notes,
          confidence: e.confidence,
          rowLabel: meta.label,
        });
      }

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

    return {
      kind: "step",
      key,
      label: meta.label,
      blocks,
      gaps,
    } satisfies StepRow;
  });
});

// ── Vue liste ─────────────────────────────────────────────────────────────────

type ListEntry = {
  from: number;
  fromLabel: string;
  trackKey: string;
  dimension: string;
  value: string;
  role?: RoleQualifier;
  confidence?: string;
  notes?: string;
  sources?: string[];
  isEvent?: boolean;
};

const listEntries = computed((): ListEntry[] => {
  const tl = timeline.value;
  if (!tl) return [];
  const result: ListEntry[] = [];

  for (const key of presentTrackKeys(tl)) {
    const meta = TRACK_META[key];
    for (const e of getTrack(tl, key)!.entries) {
      result.push({
        from: e.from,
        fromLabel:
          formatYear({
            year: e.from,
            precision: e.from_precision ?? 9,
            circa: e.from_circa,
          }) ?? String(e.from),
        trackKey: key,
        dimension: meta.label,
        // On garde le rôle dans sa colonne dédiée, pas dans la valeur.
        value: formatTrackEntry(key, { ...e, role: undefined }),
        role: meta.hasRole ? e.role : undefined,
        confidence: e.confidence,
        notes: e.notes,
        sources: e.sources,
      });
    }
  }

  for (const ev of tl.events ?? []) {
    result.push({
      from: ev.year,
      fromLabel:
        formatYear({
          year: ev.year,
          precision: ev.year_precision ?? 9,
          circa: ev.year_circa,
        }) ?? String(ev.year),
      trackKey: "event",
      dimension: "EVENT",
      value: `${ev.type}${ev.perpetrator ? ` — ${ev.perpetrator}` : ""}`,
      confidence: ev.confidence,
      notes: ev.description,
      isEvent: true,
    });
  }

  return result.sort((a, b) => a.from - b.from);
});

const missingEntities = computed<MissingEntity[]>(
  () => timeline.value?.missing_entities ?? [],
);

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
  const tl = timeline.value;
  if (!tl?.events) return [];
  return tl.events
    .filter((e) => {
      const x = xPct(e.year);
      return x >= 0 && x <= 100;
    })
    .map((e) => ({
      year: e.year,
      from: e.year,
      to: e.year,
      fromPrecision: e.year_precision ?? 9,
      fromCirca: e.year_circa,
      icon: EVENT_ICONS[e.type] ?? "●",
      label: `${e.type}${e.perpetrator ? " — " + e.perpetrator : ""}`,
      notes: e.description,
      confidence: e.confidence,
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
watch(() => timeScale.mode.value, scrollToCursor);

// ── Tooltip ───────────────────────────────────────────────────────────────────
const tooltip = reactive({
  visible: false,
  x: 0,
  y: 0,
  period: "",
  rowLabel: "",
  value: "",
  role: "",
  confidence: "",
  notes: "",
});

function showTooltip(event: MouseEvent, data: any) {
  tooltip.period = periodLabel(data.from, data.to, data.open);
  tooltip.rowLabel = data.rowLabel ?? "";
  tooltip.value = data.label ?? "";
  tooltip.role = data.role ?? "";
  tooltip.confidence = data.confidence ?? "";
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
  if (y + 170 > window.innerHeight) y = event.clientY - 170;
  tooltip.x = x;
  tooltip.y = y;
}

document.addEventListener("mousemove", (e) => {
  if (tooltip.visible) moveTooltip(e as MouseEvent);
});
</script>

<style lang="scss" scoped>
// Largeur fixe des labels — doit correspondre à LABEL_W dans le script
$label-w: 62px;
$lane-h: 17px;

.track-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

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

.tl-axis-wrap {
  position: relative;
  height: 100%;
  flex-shrink: 0;
}

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
  min-height: 32px;
  margin-bottom: 4px;
  position: relative;

  // Une piste co-occurrente empile N couloirs : le label s'aligne en haut.
  &--lanes {
    align-items: flex-start;
    .tl-row-label {
      padding-top: 2px;
      align-items: flex-start;
      height: auto;
      align-self: stretch;
    }
  }
}

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

.tl-row-track {
  flex-shrink: 0;
  position: relative;
  height: 22px;

  &--events {
    overflow: visible;
  }
}

// ── Couloirs (pistes co-occurrentes) ─────────────────────────────────────────
.tl-lanes {
  flex-shrink: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.tl-lane {
  position: relative;
  height: $lane-h;
}

.tl-seg {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  display: flex;
  align-items: center;
  padding: 0 5px;
  font-size: 10.5px;
  box-sizing: border-box;
  transition:
    filter 0.15s,
    opacity 0.15s;

  &:hover {
    filter: brightness(1.35);
    z-index: 10;
  }
  &.active {
    outline: 1.5px solid rgba(255, 255, 255, 0.5);
    z-index: 5;
  }

  // Le RÔLE se lit à la bordure autant qu'à l'opacité du fond.
  &--state {
    border: 1px solid rgba(255, 255, 255, 0.42);
  }
  &--major {
    border: 1px solid rgba(255, 255, 255, 0.22);
  }
  &--minor {
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  &--minority {
    border: 1px dashed rgba(255, 255, 255, 0.28);
  }
  &--unknown {
    border: 1px dotted rgba(255, 255, 255, 0.15);
  }

  // Fermeture IMPLICITE (ni `to` explicite, ni entrée ultérieure de la même
  // entité) : on ne sait pas quand ça s'arrête. Le segment s'estompe au lieu de
  // s'arrêter net — l'ignorance doit se voir.
  &.open {
    border-right: none;
    mask-image: linear-gradient(to right, #000 55%, transparent 100%);
    -webkit-mask-image: linear-gradient(to right, #000 55%, transparent 100%);
  }
}

// ── Curseur ───────────────────────────────────────────────────────────────────
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

  // Sur une pile de couloirs, le curseur traverse toute la hauteur sans pastille.
  &--lanes {
    top: 0;
    bottom: 0;
    &::before {
      display: none;
    }
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
  min-width: 78px;
  flex-shrink: 0;
  opacity: 0.7;
}
.tl-dim-site_type {
  color: #c9a84c;
}
.tl-dim-polity {
  color: #7eb8a0;
}
.tl-dim-culture {
  color: #a07eb8;
}
.tl-dim-religion {
  color: #b8927e;
}
.tl-dim-language {
  color: #7eb0b8;
}
.tl-dim-name {
  color: #7e9eb8;
}
.tl-dim-population {
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

// Rôle (religion / langue)
.tl-list-role {
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 2px;
  flex-shrink: 0;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.tl-role-state {
  color: #d8c37a;
  border: 1px solid rgba(216, 195, 122, 0.45);
  background: rgba(216, 195, 122, 0.08);
}
.tl-role-major {
  color: #a8bfa0;
  border: 1px solid rgba(168, 191, 160, 0.35);
}
.tl-role-minor {
  color: #8fa3b0;
  border: 1px solid rgba(143, 163, 176, 0.28);
}
.tl-role-minority {
  color: #a99ab0;
  border: 1px dashed rgba(169, 154, 176, 0.4);
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

// ── Lacunes du référentiel ───────────────────────────────────────────────────
.tl-missing {
  margin-top: 14px;
  padding: 10px 8px;
  border: 1px dashed var(--border);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.02);
}

.tl-missing-title {
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}

.tl-missing-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 16px;
}

.tl-missing-name {
  color: var(--text);
  flex-shrink: 0;
}

.tl-missing-qid {
  font-size: 13px;
  color: var(--accent);
  border: 1px solid rgba(201, 168, 76, 0.3);
  border-radius: 2px;
  padding: 1px 5px;
  flex-shrink: 0;
}

.tl-missing-ctx {
  color: var(--muted);
  font-style: italic;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
