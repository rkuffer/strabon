<template>
  <!-- Année courante -->
  <div class="ruler-year">
    <span class="ruler-year-val">{{ yearDisplay.value }}</span>
    <span class="ruler-year-era">{{ yearDisplay.era }}</span>
  </div>

  <!-- Frise principale -->
  <div class="ruler-wrap">
    <button
      class="ruler-arrow"
      @mousedown="startScroll(-1)"
      @mouseup="stopScroll"
      @mouseleave="stopScroll"
      aria-label="Scroll left"
    >
      ‹
    </button>

    <div class="ruler-scroll" ref="scrollEl" @wheel.prevent="onWheel">
      <div class="ruler-cells">
        <button
          v-for="cell in cells"
          :key="cell.year"
          class="ruler-cell"
          :class="{ active: isActive(cell), 'era-start': !!cell.eraLabel }"
          :data-era="cell.eraLabel ?? ''"
          @click="selectYear(cell.year)"
        >
          {{ cell.label }}
        </button>
      </div>
    </div>

    <button
      class="ruler-arrow ruler-arrow--right"
      @mousedown="startScroll(1)"
      @mouseup="stopScroll"
      @mouseleave="stopScroll"
      aria-label="Scroll right"
    >
      ›
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useTemporalStore } from "../../stores/temporal";
import { FRISE_SEGMENTS } from "@strabon/shared";

const temporal = useTemporalStore();
const scrollEl = ref<HTMLDivElement>();

// ── Affichage de l'année ──────────────────────────────────────────────────────
const yearDisplay = computed(() => {
  const y = temporal.year;
  return {
    value: String(Math.abs(y)),
    era: y < 0 ? "BC" : "AD",
  };
});

// ── Ères (en anglais) ─────────────────────────────────────────────────────────
const ERAS = [
  { label: "Paleolithic", from: -10000, to: -3500 },
  { label: "Neolithic", from: -3500, to: -2200 },
  { label: "Bronze Age", from: -2200, to: -1200 },
  { label: "Iron Age", from: -1200, to: -500 },
  { label: "Antiquity", from: -500, to: 500 },
  { label: "Medieval", from: 500, to: 1500 },
  { label: "Modern", from: 1500, to: 2000 },
];

// ── Cellules ──────────────────────────────────────────────────────────────────
type Cell = {
  year: number;
  end: number;
  step: number;
  label: string;
  eraLabel?: string;
};

const cells = computed((): Cell[] => {
  const result: Cell[] = [];
  const eraStarts = new Map(ERAS.map((e) => [e.from, e.label]));
  for (const seg of FRISE_SEGMENTS) {
    for (let y = seg.from; y < seg.to; y += seg.step) {
      result.push({
        year: y,
        end: y + seg.step,
        step: seg.step,
        label: `${Math.abs(y)}${y < 0 ? " BC" : " AD"}`,
        eraLabel: eraStarts.get(y),
      });
    }
  }
  return result;
});

function isActive(cell: Cell): boolean {
  return temporal.year >= cell.year && temporal.year < cell.end;
}

function selectYear(year: number) {
  temporal.setYear(year);
  if (temporal.playing) temporal.playing = false;
}

// ── Scroll continu (mousedown → mouseup) ──────────────────────────────────────
let scrollInterval: ReturnType<typeof setInterval> | null = null;

function startScroll(direction: 1 | -1) {
  stopScroll();
  doScroll(direction);
  scrollInterval = setInterval(() => doScroll(direction), 120);
}

function stopScroll() {
  if (scrollInterval) {
    clearInterval(scrollInterval);
    scrollInterval = null;
  }
}

function doScroll(direction: 1 | -1) {
  if (!scrollEl.value) return;
  scrollEl.value.scrollBy({ left: direction * 60 });
}

// ── Scroll molette ────────────────────────────────────────────────────────────
function onWheel(e: WheelEvent) {
  if (!scrollEl.value) return;
  e.preventDefault();
  scrollEl.value.scrollBy({ left: e.deltaY + e.deltaX });
}

// ── Scroll vers la case active au montage ────────────────────────────────────
async function scrollToCurrent() {
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
  }

  const cellEls = scrollEl.value.querySelectorAll<HTMLElement>(".ruler-cell");
  const activeCellData = cells.value.find(isActive);
  let offsetX = 0;
  let activeCellEl: HTMLElement | undefined;

  cellEls.forEach((el, i) => {
    if (cells.value[i] === activeCellData) {
      activeCellEl = el;
    } else if (!activeCellEl) {
      offsetX += el.offsetWidth;
    }
  });

  if (!activeCellEl) return;
  const containerW = scrollEl.value.clientWidth;
  scrollEl.value.scrollLeft = Math.max(
    0,
    offsetX - containerW / 2 + activeCellEl.offsetWidth / 2,
  );
}

onMounted(scrollToCurrent);
onUnmounted(() => stopScroll());
</script>

<style lang="scss" scoped>
.ruler-year {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  min-width: 72px;
  border-right: 1px solid var(--border);
  align-self: stretch;
}

.ruler-year-val {
  font-family: var(--font-head);
  font-size: 22px;
  color: var(--accent);
  letter-spacing: 0.04em;
  line-height: 1;
}

.ruler-year-era {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.1em;
  margin-top: 2px;
}

.ruler-wrap {
  flex: 1;
  display: flex;
  align-items: stretch;
  min-width: 0;
  border-right: 1px solid var(--border);
  align-self: stretch;
}

.ruler-arrow {
  flex: 0 0 22px;
  background: none;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    color 0.15s,
    background 0.15s;
  padding: 0;

  &:hover {
    color: var(--accent);
    background: rgba(201, 168, 76, 0.05);
  }
  &--right {
    border-right: none;
    border-left: 1px solid var(--border);
  }
}

.ruler-scroll {
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  display: flex;
  flex-direction: column;
  align-self: stretch;
}

.ruler-cells {
  display: flex;
  flex-shrink: 0;
  flex: 1;
}

.ruler-cell {
  flex-shrink: 0;
  height: 100%;
  background: none;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--muted);
  font-family: var(--font-body);
  font-size: 20px;
  letter-spacing: 0.03em;
  cursor: pointer;
  white-space: nowrap;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    color 0.1s,
    background 0.1s;

  &:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.04);
  }

  &.active {
    background: rgba(201, 168, 76, 0.15);
    color: var(--accent);
    border-right-color: rgba(201, 168, 76, 0.3);
  }

  &.era-start {
    border-left: 1px solid rgba(201, 168, 76, 0.25);
    position: relative;

    &::before {
      content: attr(data-era);
      position: absolute;
      top: 3px;
      left: 4px;
      font-size: 8px;
      letter-spacing: 0.07em;
      color: var(--accent);
      opacity: 0.4;
      pointer-events: none;
      white-space: nowrap;
    }
  }
}
</style>
