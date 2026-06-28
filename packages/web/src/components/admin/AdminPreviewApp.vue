<template>
  <div v-if="state.timeline" class="admin-preview">

    <!-- En-tête avec actions -->
    <div class="preview-actions">
      <div class="preview-actions-left">
        <span class="preview-label">Aperçu de la timeline extraite</span>
        <span class="text-muted" style="font-size:12px">{{ trackSummary }}</span>
      </div>
      <div class="preview-actions-right">
        <button class="btn btn-ghost btn-sm" @click="toggleRaw">{{ showRaw ? 'Masquer JSON' : 'Voir JSON' }}</button>
        <button class="btn btn-sm" @click="reject">✕ Rejeter</button>
        <button class="btn btn-primary btn-sm" @click="confirm" :disabled="confirming">
          {{ confirming ? '⏳ Enregistrement...' : '✓ Valider et enregistrer' }}
        </button>
      </div>
    </div>

    <!-- Feedback confirmation -->
    <div v-if="confirmResult" class="confirm-result" :class="confirmResult.ok ? 'ok' : 'error'">
      <template v-if="confirmResult.ok">
        ✅ Timeline enregistrée.
        <span v-if="confirmResult.polities_added"> +{{ confirmResult.polities_added }} politi{{ confirmResult.polities_added > 1 ? 'es' : 'e' }}</span>
        <span v-if="confirmResult.cultures_added"> +{{ confirmResult.cultures_added }} cultur{{ confirmResult.cultures_added > 1 ? 'es' : 'e' }}</span>
      </template>
      <template v-else>
        ❌ Erreur : {{ confirmResult.error }}
      </template>
    </div>

    <!-- Frise timeline (réutilise le composant de la carte) -->
    <div class="preview-timeline">
      <TimelineTrack :site="previewSite" :year="previewYear" />
    </div>

    <!-- Slider d'année pour naviguer dans la frise -->
    <div class="preview-year-control">
      <label class="text-muted" style="font-size:12px">Année d'aperçu :</label>
      <input type="range" v-model.number="previewYear"
        :min="timelineMin" :max="timelineMax" step="10"
        style="flex:1" />
      <span class="year-badge">
        {{ previewYear < 0 ? Math.abs(previewYear) + ' BC' : previewYear + ' AD' }}
      </span>
    </div>

    <!-- JSON brut éditable -->
    <div v-if="showRaw" class="raw-editor">
      <textarea v-model="rawJson" class="raw-textarea" spellcheck="false" @input="parseRaw" />
      <div v-if="parseError" class="parse-error">{{ parseError }}</div>
    </div>

  </div>

  <div v-else class="preview-empty">
    <!-- Vide tant que pas d'extraction -->
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import TimelineTrack from "../timeline/TimelineTrack.vue";
import type { SiteTimeline } from "@strabon/shared";

const props = defineProps<{
  siteId:      string;
  siteTitle:   string;
  hasExisting: boolean;
}>();

// ── État ──────────────────────────────────────────────────────────────────────
const state = ref<{
  timeline:     SiteTimeline | null;
  model:        string;
  extractedAt:  string;
}>({ timeline: null, model: "", extractedAt: "" });

const showRaw    = ref(false);
const rawJson    = ref("");
const parseError = ref("");
const confirming = ref(false);
const confirmResult = ref<any>(null);

const previewYear = ref(-1000);

// ── Site simulé pour TimelineTrack ───────────────────────────────────────────
const previewSite = computed(() => ({
  id:                    props.siteId,
  title_en:              props.siteTitle,
  wikipedia_page_en_url: "",
  timeline:              state.value.timeline,
  inception_year:        timelineMin.value,
  dissolution_year:      null,
  meta:                  {},
}));

// ── Plage temporelle de la timeline ──────────────────────────────────────────
const timelineMin = computed(() => {
  const tl = state.value.timeline;
  if (!tl) return -5000;
  const froms: number[] = [];
  for (const track of [tl.site_type, tl.polity, tl.culture, tl.name, tl.population]) {
    if (track?.entries) froms.push(...track.entries.map(e => e.from));
  }
  return froms.length ? Math.min(...froms) : -5000;
});

const timelineMax = computed(() => {
  const tl = state.value.timeline;
  if (!tl) return 2000;
  const froms: number[] = [];
  for (const track of [tl.site_type, tl.polity, tl.culture, tl.name, tl.population]) {
    if (track?.entries) froms.push(...track.entries.map(e => e.from));
  }
  if (tl.events) froms.push(...tl.events.map(e => e.year));
  return froms.length ? Math.max(...froms) + 100 : 2000;
});

const trackSummary = computed(() => {
  const tl = state.value.timeline;
  if (!tl) return "";
  const parts = Object.entries(tl)
    .map(([k, v]: [string, any]) =>
      k === "events" ? `${v?.length ?? 0} events` : `${k}: ${v?.entries?.length ?? 0}`
    );
  return parts.join(" · ");
});

// ── Écoute l'événement depuis la page Eta ────────────────────────────────────
function onTimelineExtracted(e: Event) {
  const { timeline, model, extracted_at } = (e as CustomEvent).detail;
  state.value = { timeline, model: model ?? "", extractedAt: extracted_at ?? "" };
  rawJson.value = JSON.stringify(timeline, null, 2);
  parseError.value = "";
  confirmResult.value = null;
  // Centrer le slider sur le milieu de la plage
  previewYear.value = Math.round((timelineMin.value + timelineMax.value) / 2);
}

onMounted(() => window.addEventListener("timeline-extracted", onTimelineExtracted));
onUnmounted(() => window.removeEventListener("timeline-extracted", onTimelineExtracted));

// ── JSON brut ─────────────────────────────────────────────────────────────────
function toggleRaw() { showRaw.value = !showRaw.value; }

function parseRaw() {
  try {
    state.value.timeline = JSON.parse(rawJson.value);
    parseError.value = "";
  } catch (e: any) {
    parseError.value = e.message;
  }
}

// ── Confirm / Reject ─────────────────────────────────────────────────────────
async function confirm() {
  if (!state.value.timeline) return;
  confirming.value = true;
  confirmResult.value = null;

  const res = await fetch(`/admin/extract/${props.siteId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeline:      state.value.timeline,
      model:         state.value.model,
      extracted_at:  state.value.extractedAt,
    }),
  });
  const data = await res.json();
  confirmResult.value = res.ok ? data : { ok: false, error: data.error };
  confirming.value = false;
}

function reject() {
  state.value.timeline = null;
  confirmResult.value = null;
  showRaw.value = false;
}
</script>

<style lang="scss" scoped>
.admin-preview {
  margin-top: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
}

.preview-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  gap: 12px;
  flex-wrap: wrap;
}
.preview-actions-left { display: flex; flex-direction: column; gap: 2px; }
.preview-actions-right { display: flex; gap: 8px; align-items: center; }
.preview-label { font-size: 12px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; }

.confirm-result {
  padding: 8px 14px;
  font-size: 13px;
  &.ok    { background: rgba(90,154,106,.1); color: #7eb8a0; border-bottom: 1px solid rgba(90,154,106,.2); }
  &.error { background: rgba(192,112,96,.1); color: #c07060; border-bottom: 1px solid rgba(192,112,96,.2); }
}

.preview-timeline {
  padding: 12px 14px;
  height: 220px;
  display: flex;
  flex-direction: column;
}

.preview-year-control {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
}

.year-badge {
  font-family: var(--font-head);
  font-size: 13px;
  color: var(--accent);
  min-width: 80px;
  text-align: right;
}

.raw-editor { border-top: 1px solid var(--border); }
.raw-textarea {
  width: 100%;
  height: 300px;
  background: var(--bg);
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  padding: 12px;
  border: none;
  resize: vertical;
  outline: none;
  display: block;
}
.parse-error {
  padding: 6px 12px;
  background: rgba(192,112,96,.1);
  color: #c07060;
  font-size: 12px;
}
</style>
