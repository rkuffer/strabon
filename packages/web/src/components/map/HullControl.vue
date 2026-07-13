<!-- HullControl.vue — Floating hull-kind selector, bottom right of the map. -->
<template>
  <div ref="rootEl" class="hull-control">
    <div class="kinds">
      <button
        v-for="k in HULL_KINDS"
        :key="k"
        class="kind"
        :class="{ active: mapStore.hullKind === k }"
        :title="KIND_TITLE[k]"
        @click="toggle(k)"
      >
        <span class="glyph">{{ KIND_GLYPH[k] }}</span>
        <span class="label">{{ KIND_LABEL[k] }}</span>
      </button>
    </div>

    <!-- The role filter only means something on a co-occurrent track. -->
    <div v-if="showRoles" class="roles">
      <span class="roles-title">Down to</span>
      <button
        v-for="r in ROLE_ORDER"
        :key="r"
        class="role"
        :class="{ active: mapStore.hullMinRole === r }"
        :title="ROLE_TITLE[r]"
        @click="mapStore.hullMinRole = r"
      >
        {{ ROLE_LABEL[r] }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import L from "leaflet";
import {
  HULL_KINDS,
  ROLE_ORDER,
  type HullKind,
  type RoleQualifier,
} from "@strabon/shared";
import { useMapStore } from "../../stores/map";

const mapStore = useMapStore();
const rootEl = ref<HTMLDivElement>();

const KIND_LABEL: Record<HullKind, string> = {
  polity: "Polities",
  culture: "Cultures",
  religion: "Religions",
  language: "Languages",
};

const KIND_TITLE: Record<HullKind, string> = {
  polity: "States, empires, kingdoms holding the site",
  culture: "Archaeological cultures attested at the site",
  religion: "Religions present at the site",
  language: "Languages spoken at the site",
};

const KIND_GLYPH: Record<HullKind, string> = {
  polity: "⚔",
  culture: "🏺",
  religion: "☾",
  language: "✎",
};

// Role labels are deliberately terse — the control is a filter, not a lesson.
// The titles carry the meaning.
const ROLE_LABEL: Record<RoleQualifier, string> = {
  state: "State",
  major: "Major",
  minor: "Minor",
  minority: "Minority",
};

const ROLE_TITLE: Record<RoleQualifier, string> = {
  state: "Only the officially established entity",
  major: "The dominant entity and above",
  minor: "Down to entities with a limited presence",
  minority:
    "Down to scattered communities — the hull of medieval European Jewry",
};

// Roles only exist on the co-occurrent tracks.
const showRoles = computed(
  () => mapStore.hullKind === "religion" || mapStore.hullKind === "language",
);

/** Clicking the active kind switches the layer off entirely. */
function toggle(k: HullKind) {
  mapStore.hullKind = mapStore.hullKind === k ? null : k;
}

onMounted(() => {
  // The control lives inside the Leaflet container, so Leaflet would otherwise
  // treat clicks on it as map drags and wheel events as map zooms.
  if (!rootEl.value) return;
  L.DomEvent.disableClickPropagation(rootEl.value);
  L.DomEvent.disableScrollPropagation(rootEl.value);
});
</script>

<style lang="scss" scoped>
.hull-control {
  position: absolute;
  right: 12px;
  bottom: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
  font-size: 12px;
}

.kinds,
.roles {
  display: flex;
  background: rgba(20, 20, 24, 0.88);
  border: 1px solid var(--border, #33333c);
  border-radius: 6px;
  overflow: hidden;
  backdrop-filter: blur(6px);
}

.kind {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--border, #33333c);
  color: #9a9aa4;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;

  &:last-child {
    border-right: 0;
  }

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: #d8d8e0;
  }

  &.active {
    background: rgba(201, 168, 76, 0.18);
    color: #e8d9a4;
  }
}

.glyph {
  font-size: 13px;
  line-height: 1;
}

.roles {
  align-items: center;
  padding-left: 8px;
}

.roles-title {
  color: #6a6a74;
  margin-right: 4px;
  letter-spacing: 0.04em;
}

.role {
  padding: 6px 8px;
  background: transparent;
  border: 0;
  color: #9a9aa4;
  cursor: pointer;

  &:hover {
    color: #d8d8e0;
  }

  &.active {
    color: #e8d9a4;
    font-weight: 600;
  }
}
</style>
