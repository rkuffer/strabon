<template>
  <header class="map-header">
    <!-- Burger + menu navigation -->
    <div class="burger-wrap" ref="burgerWrap">
      <button
        class="burger"
        :class="{ open: menuOpen }"
        @click="toggleMenu"
        aria-label="Menu"
      >
        <span /><span /><span />
      </button>
      <Transition name="menu">
        <nav v-if="menuOpen" class="nav-menu">
          <div class="nav-menu-header">
            <span class="nav-brand">STRABON</span>
          </div>
          <ul class="nav-menu-links">
            <li><a href="/" class="nav-link nav-link--active">🗺 Carte</a></li>
            <li><a href="/sites" class="nav-link">📋 Sites</a></li>
            <li><a href="/polities" class="nav-link">⚔ Polities</a></li>
            <li><a href="/cultures" class="nav-link">🏺 Cultures</a></li>
            <li><a href="/about" class="nav-link">ℹ About</a></li>
            <li class="nav-sep" />
            <li>
              <a href="/admin" class="nav-link nav-link--admin">⚙ Admin</a>
            </li>
          </ul>
        </nav>
      </Transition>
    </div>

    <!-- Titre -->
    <h1 class="map-title">
      STRABON <span class="map-subtitle">TEMPORAL EXPLORER</span>
    </h1>

    <!-- Bouton play -->
    <button class="btn-play" @click="togglePlay">
      {{ temporal.playing ? "⏸" : "▶" }}
    </button>

    <!-- Frise temporelle (year + ruler + scale toggle) -->
    <TimeRuler />

    <!-- Filtre sites -->
    <div class="filter-wrap" ref="filterWrap">
      <button
        class="btn-icon"
        @click="filterOpen = !filterOpen"
        title="Filtre sites"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
        >
          <path d="M1 2h12M3 7h8M5 12h4" stroke-linecap="round" />
        </svg>
      </button>
      <Transition name="menu">
        <div v-if="filterOpen" class="filter-menu">
          <button
            v-for="opt in filterOptions"
            :key="opt.value"
            class="filter-option"
            :class="{ active: temporal.siteFilter === opt.value }"
            @click="selectFilter(opt.value)"
          >
            <span class="filter-dot" :class="opt.color" />
            {{ opt.label }}
          </button>
        </div>
      </Transition>
    </div>

    <!-- Recherche site -->
    <div class="search-wrap" ref="searchWrap">
      <svg
        class="search-icon"
        width="13"
        height="13"
        viewBox="0 0 13 13"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
      >
        <circle cx="5.5" cy="5.5" r="4" />
        <path d="M9 9l3 3" stroke-linecap="round" />
      </svg>
      <input
        class="search-input"
        type="text"
        placeholder="Rechercher un site…"
        v-model="searchQuery"
        @focus="searchFocused = true"
        @keydown="onSearchKeydown"
      />
      <Transition name="menu">
        <div v-if="showResults" class="search-results">
          <div v-if="searchLoading && !results.length" class="search-status">
            Recherche…
          </div>
          <div v-else-if="!results.length" class="search-status">
            Aucun résultat
          </div>
          <button
            v-for="(r, i) in results"
            :key="r.id"
            class="search-result"
            :class="{ active: i === activeIndex }"
            @mouseenter="activeIndex = i"
            @mousedown.prevent="selectResult(r)"
          >
            <span class="search-result-title">{{ r.title }}</span>
            <span v-if="r.country" class="search-result-country">{{
              r.country
            }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <span class="stat-visible">
      <strong>{{ visibleCount }}</strong> sites
    </span>
  </header>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import TimeRuler from "../ui/TimeRuler.vue";
import { useTemporalStore, type SiteFilter } from "../../stores/temporal";
import { useMapStore } from "../../stores/map";
import { useSiteSearchQuery } from "../../api/client";
import type { SiteSearchResult } from "@strabon/shared";

const temporal = useTemporalStore();
const map = useMapStore();
const visibleCount = ref(0);
const menuOpen = ref(false);
const filterOpen = ref(false);
const searchQuery = ref("");
const burgerWrap = ref<HTMLElement>();
const filterWrap = ref<HTMLElement>();
const searchWrap = ref<HTMLElement>();

// ── Recherche / autocomplete ──────────────────────────────────────────────────
const searchFocused = ref(false);
const activeIndex = ref(0);

const searchResult = useSiteSearchQuery(searchQuery);
const results = computed<SiteSearchResult[]>(
  () => searchResult.data.value ?? [],
);
const searchLoading = computed(() => searchResult.isFetching.value);
const showResults = computed(
  () => searchFocused.value && searchQuery.value.trim().length >= 2,
);

// Garde l'index actif dans les bornes quand la liste change
watch(results, (r) => {
  if (activeIndex.value >= r.length) activeIndex.value = 0;
});

function selectResult(r: SiteSearchResult) {
  map.focusSite(r.lat, r.lon, { id: r.id });
  searchQuery.value = "";
  searchFocused.value = false;
  activeIndex.value = 0;
}

function onSearchKeydown(e: KeyboardEvent) {
  const n = results.value.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (n) activeIndex.value = (activeIndex.value + 1) % n;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (n) activeIndex.value = (activeIndex.value - 1 + n) % n;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = results.value[activeIndex.value];
    if (r) selectResult(r);
  } else if (e.key === "Escape") {
    searchQuery.value = "";
    searchFocused.value = false;
    (e.target as HTMLInputElement).blur();
  }
}

const filterOptions: { value: SiteFilter; label: string; color: string }[] = [
  { value: "timeline_only", label: "Sites avec timeline", color: "green" },
  { value: "all", label: "Tous les sites", color: "yellow" },
  { value: "no_timeline", label: "Sans timeline", color: "red" },
];

function selectFilter(v: SiteFilter) {
  temporal.siteFilter = v;
  filterOpen.value = false;
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}
function togglePlay() {
  temporal.playing = !temporal.playing;
}

function onClickOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (burgerWrap.value && !burgerWrap.value.contains(t)) menuOpen.value = false;
  if (filterWrap.value && !filterWrap.value.contains(t))
    filterOpen.value = false;
  if (searchWrap.value && !searchWrap.value.contains(t))
    searchFocused.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    menuOpen.value = false;
    filterOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener("click", onClickOutside);
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  document.removeEventListener("click", onClickOutside);
  document.removeEventListener("keydown", onKey);
});
</script>

<style lang="scss" scoped>
.map-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  z-index: 1000;
  position: relative;
  height: 56px;
}

// ── Burger ────────────────────────────────────────────────────────────────────
.burger-wrap {
  position: relative;
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-right: 1px solid var(--border);
}

.burger {
  background: none;
  border: 1px solid var(--border);
  border-radius: 2px;
  width: 30px;
  height: 28px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 4px;
  padding: 0;
  transition: border-color 0.15s;

  &:hover {
    border-color: var(--accent);
  }

  span {
    display: block;
    width: 14px;
    height: 1.5px;
    background: var(--text);
    border-radius: 1px;
    transition:
      transform 0.2s,
      opacity 0.2s;
    transform-origin: center;
  }
  &.open span:nth-child(1) {
    transform: translateY(5.5px) rotate(45deg);
  }
  &.open span:nth-child(2) {
    opacity: 0;
  }
  &.open span:nth-child(3) {
    transform: translateY(-5.5px) rotate(-45deg);
  }
}

.nav-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: 220px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  z-index: 2000;
  overflow: hidden;
}
.nav-menu-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.nav-brand {
  font-family: var(--font-head);
  font-size: 12px;
  letter-spacing: 0.15em;
  color: var(--accent);
}
.nav-menu-links {
  list-style: none;
  padding: 6px 0;
}
.nav-link {
  display: block;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--muted);
  text-decoration: none;
  letter-spacing: 0.04em;
  transition:
    color 0.12s,
    background 0.12s;
  &:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.04);
  }
  &--active {
    color: var(--text);
  }
  &--admin {
    color: var(--accent);
    opacity: 0.7;
    &:hover {
      opacity: 1;
    }
  }
}
.nav-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 10px;
}

// ── Titre ─────────────────────────────────────────────────────────────────────
.map-title {
  font-family: var(--font-head);
  font-size: 14px;
  font-weight: 400;
  letter-spacing: 0.12em;
  color: var(--accent);
  white-space: nowrap;
  flex-shrink: 0;
  padding: 0 14px;
  border-right: 1px solid var(--border);
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.map-subtitle {
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.08em;
  display: block;
  margin-top: 2px;
}

// ── Play ──────────────────────────────────────────────────────────────────────
.btn-play {
  background: none;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  width: 36px;
  height: 100%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    color 0.15s,
    background 0.15s;

  &:hover {
    color: var(--accent);
    background: rgba(201, 168, 76, 0.05);
  }
}

// ── Filtre (icône seule) ──────────────────────────────────────────────────────
.filter-wrap {
  position: relative;
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  border-left: 1px solid var(--border);
}

.btn-icon {
  width: 36px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;

  &:hover {
    color: var(--accent);
    background: rgba(201, 168, 76, 0.05);
  }
}

.filter-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 200px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  z-index: 2000;
  padding: 4px 0;
}
.filter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  padding: 8px 14px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  transition:
    color 0.12s,
    background 0.12s;
  &:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.04);
  }
  &.active {
    color: var(--text);
  }
}
.filter-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  &.green {
    background: #5a9a6a;
  }
  &.yellow {
    background: var(--accent);
  }
  &.red {
    background: #9a4a3a;
  }
}

// ── Recherche ─────────────────────────────────────────────────────────────────
.search-wrap {
  flex: 0 0 190px;
  border-left: 1px solid var(--border);
  align-self: stretch;
  display: flex;
  align-items: center;
  padding: 0 10px;
  gap: 7px;
  position: relative;
}

.search-icon {
  color: var(--muted);
  opacity: 0.4;
  flex-shrink: 0;
}

.search-input {
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--font-body);
  font-size: 12px;
  letter-spacing: 0.03em;
  width: 100%;

  &::placeholder {
    color: var(--muted);
    opacity: 0.35;
  }
}

// ── Dropdown autocomplete ─────────────────────────────────────────────────────
.search-results {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 260px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  z-index: 2000;
  padding: 4px 0;

  &::-webkit-scrollbar {
    width: 5px;
  }
  &::-webkit-scrollbar-thumb {
    background: #3a3e38;
    border-radius: 3px;
  }
}

.search-status {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  opacity: 0.7;
}

.search-result {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  padding: 8px 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;

  &:hover,
  &.active {
    background: rgba(255, 255, 255, 0.05);
  }
}

.search-result-title {
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-result-country {
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}

// ── Stat ──────────────────────────────────────────────────────────────────────
.stat-visible {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  flex-shrink: 0;
  padding: 0 12px;
  border-left: 1px solid var(--border);
  align-self: stretch;
  display: flex;
  align-items: center;

  strong {
    color: var(--text);
  }
}

// ── Animations ────────────────────────────────────────────────────────────────
.menu-enter-active,
.menu-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
