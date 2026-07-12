// =============================================================================
// timeline-utils.ts — Utilitaires de lecture des timelines (Modèle A)
// Partagés entre @strabon/server et @strabon/web
//
// Trois régimes de piste coexistent (voir TRACK_META dans site-types.ts) :
//   - "step"        : escalier — une valeur active à la fois (polity, culture,
//                     name, population). Lecture : getValueAt / getEntryAt.
//   - "occupation"  : escalier + `to` = hiatus d'occupation (site_type).
//                     Lecture : idem + isInOccupationGap / getOccupationGaps.
//   - "cooccurrent" : PLUSIEURS valeurs actives simultanément (religion, language).
//                     Lecture : getActiveEntriesAt / buildLanes.
//
// Les fonctions en escalier ne doivent PAS être utilisées sur une piste
// co-occurrente : elles y renverraient une seule entrée arbitraire.
// =============================================================================

import {
  TRACK_KEYS,
  TRACK_META,
  isCooccurrent,
  roleRank,
} from "./site-types.js";
import type {
  Track,
  TrackEntry,
  TrackKey,
  SiteEntry,
  SiteTimeline,
  SiteType,
  RoleQualifier,
  EntityRef,
} from "./site-types.js";

// ── Accès générique aux pistes ────────────────────────────────────────────────

/**
 * Retourne la piste `key` d'une timeline, sans présumer de son type.
 * Point de passage unique : évite les listes de pistes écrites en dur, qui
 * faisaient silencieusement disparaître une dimension des calculs.
 */
export function getTrack(
  timeline: SiteTimeline | undefined,
  key: TrackKey,
): Track<any> | undefined {
  return timeline?.[key] as Track<any> | undefined;
}

/** Toutes les entrées de toutes les pistes, dans l'ordre de TRACK_KEYS. */
export function allTrackEntries(
  timeline: SiteTimeline | undefined,
): TrackEntry<any>[] {
  if (!timeline) return [];
  const out: TrackEntry<any>[] = [];
  for (const key of TRACK_KEYS) {
    const entries = getTrack(timeline, key)?.entries;
    if (entries?.length) out.push(...entries);
  }
  return out;
}

/** Les pistes non vides d'une timeline, dans l'ordre narratif. */
export function presentTrackKeys(
  timeline: SiteTimeline | undefined,
): TrackKey[] {
  if (!timeline) return [];
  return TRACK_KEYS.filter((k) => getTrack(timeline, k)?.entries?.length);
}

// ── Identité d'entité (fermeture des pistes co-occurrentes) ───────────────────

/**
 * Clé d'identité d'une valeur de piste.
 *
 * Sur une piste co-occurrente, une entrée n'est fermée QUE par une entrée
 * ultérieure portant la MÊME entité (christianisme "minority" → "state"). Il faut
 * donc pouvoir décider si deux entrées désignent la même chose.
 *
 * Le QID est la clé fiable — c'est ce que le référentiel garantit. Le nom est un
 * repli : les entrées sans QID sont légitimes (le prompt ordonne d'omettre un QID
 * incertain), mais le nom est instable, d'où la normalisation.
 */
export function entityKey(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number")
    return normalizeName(String(value));
  const v = value as Partial<EntityRef> & { text?: string };
  // Un `wikidata` vide ou blanc n'est PAS un QID. Le modèle contourne parfois
  // l'instruction « omit the field » en écrivant "" — traiter cela comme absent,
  // sinon toutes les entités sans QID partagent la clé `qid:` et fusionnent.
  const qid = typeof v.wikidata === "string" ? v.wikidata.trim() : "";
  if (qid) return `qid:${qid}`;
  if (v.name) return `name:${normalizeName(v.name)}`;
  if (v.text) return `name:${normalizeName(v.text)}`;
  return "";
}

function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacritiques
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ── Lecture d'une piste ESCALIER à une année donnée ───────────────────────────

/**
 * Valeur active d'une piste en escalier à l'année donnée, ou null.
 *
 * NB : volontairement non "occupation-aware". Pendant un trou d'occupation
 * (site_type.to), cette fonction renvoie toujours la valeur de l'entrée qui a
 * fermé — le gating du trou est porté séparément par isInOccupationGap /
 * siteVisible (et son miroir SQL site_occupied_at). Les deux préoccupations
 * restent orthogonales, exactement comme côté SQL où track_value_at est intacte.
 *
 * NE PAS utiliser sur religion / language : voir getActiveEntriesAt.
 */
export function getValueAt<T>(
  track: Track<T> | undefined,
  year: number,
): T | null {
  return getEntryAt(track, year)?.value ?? null;
}

/** Entrée complète (from, confidence, notes…) active à l'année donnée. */
export function getEntryAt<T>(
  track: Track<T> | undefined,
  year: number,
): TrackEntry<T> | null {
  if (!track?.entries?.length) return null;
  const sorted = [...track.entries].sort((a, b) => a.from - b.from);
  let active: TrackEntry<T> | null = null;
  for (const e of sorted) {
    if (e.from <= year) active = e;
    else break;
  }
  return active;
}

/** Toutes les entrées d'une piste jusqu'à `yearTo`. */
export function getEntriesInRange<T>(
  track: Track<T> | undefined,
  yearFrom: number,
  yearTo: number,
): TrackEntry<T>[] {
  if (!track?.entries?.length) return [];
  return [...track.entries]
    .sort((a, b) => a.from - b.from)
    .filter((e) => e.from <= yearTo);
}

// ── Lecture d'une piste CO-OCCURRENTE à une année donnée ──────────────────────

/**
 * Toutes les entrées ACTIVES à l'année donnée sur une piste co-occurrente.
 *
 * Une entrée est active à `year` si :
 *   - e.from <= year, ET
 *   - elle n'est pas fermée : soit par un `to` explicite (year <= e.to), soit par
 *     une entrée ULTÉRIEURE de la MÊME entité (changement de rôle) déjà entrée
 *     en vigueur.
 *
 * Résultat trié par rôle décroissant (state → minority) puis par ancienneté.
 *
 * Cas des données pré-`to` : les timelines extraites avant l'élargissement du `to`
 * n'en portent aucun sur religion/language. Une entité disparue y restera donc
 * active jusqu'au présent. C'est un défaut de DONNÉES, pas de lecture — il se
 * corrigera à la ré-extraction, sans migration.
 */
export function getActiveEntriesAt<T>(
  track: Track<T> | undefined,
  year: number,
): TrackEntry<T>[] {
  if (!track?.entries?.length) return [];
  const sorted = [...track.entries].sort((a, b) => a.from - b.from);

  // Dernière entrée entrée en vigueur, par entité.
  const latest = new Map<string, TrackEntry<T>>();
  for (const e of sorted) {
    if (e.from > year) break;
    latest.set(entityKey(e.value), e);
  }

  return [...latest.values()]
    .filter((e) => e.to == null || year <= e.to)
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.from - b.from);
}

// ── Couloirs (rendu des pistes co-occurrentes) ────────────────────────────────

export type LaneSegment<T> = {
  from: number;
  /** Année de fermeture EFFECTIVE (résolue). */
  to: number;
  /**
   * true ⇒ la fermeture est implicite (ni `to` explicite, ni entrée ultérieure de
   * la même entité) : le segment court jusqu'à `endYear`. À rendre en dégradé ou
   * en pointillé plutôt qu'en bord franc — on ne sait pas quand ça s'arrête.
   */
  open: boolean;
  role?: RoleQualifier;
  entry: TrackEntry<T>;
};

export type EntityLane<T> = {
  /** entityKey — identifiant interne stable. */
  key: string;
  /** Nom affichable (celui de la première entrée). */
  label: string;
  wikidata?: string;
  /** Rôle le plus dominant atteint par l'entité (sert au tri des couloirs). */
  topRole?: RoleQualifier;
  segments: LaneSegment<T>[];
};

/**
 * Découpe une piste co-occurrente en COULOIRS — une sous-ligne par entité.
 *
 * C'est la fonction centrale du modèle co-occurrent. Elle applique la FERMETURE
 * PAR ENTITÉ : une entrée est close par `to` s'il existe, sinon par la prochaine
 * entrée de la MÊME entité (changement de rôle), sinon elle reste ouverte
 * jusqu'à `endYear`.
 *
 * Utilisable aussi sur une piste escalier (chaque valeur distincte y devient un
 * couloir), mais ce n'est pas le rendu voulu pour elles.
 *
 * @param endYear borne droite de la timeline (dissolution ou année courante).
 */
export function buildLanes<T>(
  track: Track<T> | undefined,
  endYear: number,
): EntityLane<T>[] {
  if (!track?.entries?.length) return [];
  const sorted = [...track.entries].sort((a, b) => a.from - b.from);

  const lanes = new Map<string, EntityLane<T>>();

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const key = entityKey(e.value);
    if (!key) continue;

    // Prochaine entrée de la MÊME entité — c'est elle, et elle seule, qui ferme.
    let nextSame: TrackEntry<T> | undefined;
    for (let j = i + 1; j < sorted.length; j++) {
      if (entityKey(sorted[j].value) === key) {
        nextSame = sorted[j];
        break;
      }
    }

    const explicitTo = e.to != null ? e.to : null;
    const closeAt = explicitTo ?? nextSame?.from ?? endYear;
    const open = explicitTo == null && !nextSame;

    let lane = lanes.get(key);
    if (!lane) {
      const v = e.value as any;
      lane = {
        key,
        label: v?.name ?? v?.text ?? String(v),
        wikidata: v?.wikidata,
        topRole: e.role,
        segments: [],
      };
      lanes.set(key, lane);
    }
    if (roleRank(e.role) < roleRank(lane.topRole)) lane.topRole = e.role;

    lane.segments.push({
      from: e.from,
      to: Math.max(closeAt, e.from),
      open,
      role: e.role,
      entry: e,
    });
  }

  // Couloirs triés : rôle dominant d'abord, puis apparition la plus ancienne.
  return [...lanes.values()].sort(
    (a, b) =>
      roleRank(a.topRole) - roleRank(b.topRole) ||
      a.segments[0].from - b.segments[0].from,
  );
}

// ── Occupation : trous (hiatus) déduits de la piste site_type ─────────────────

export type YearInterval = { from: number; to: number };

/**
 * Indique si `year` tombe dans un trou d'occupation explicite.
 *
 * Miroir EXACT de la fonction SQL site_occupied_at (inversée) :
 *   active = dernière entrée site_type avec from <= year
 *   - pas d'entrée active (year avant la 1ʳᵉ)  ⇒ pas un trou (false)
 *   - active.to absent/null                    ⇒ ouvert jusqu'à la suivante (false)
 *   - year <= active.to                        ⇒ encore occupé (false)
 *   - year >  active.to                        ⇒ trou (true)
 */
export function isInOccupationGap(
  timeline: SiteTimeline | undefined,
  year: number,
): boolean {
  const active = getEntryAt<SiteType>(timeline?.site_type, year);
  if (!active) return false; // avant la première entrée
  if (active.to == null) return false; // ouvert jusqu'à la suivante
  return year > active.to; // strictement après la fermeture ⇒ trou
}

/**
 * Trous d'occupation (hiatus) sous forme d'intervalles (to, next.from), déduits
 * de la piste site_type. Un `to` sans entrée suivante n'est PAS un trou (c'est une
 * dissolution) — on n'inspecte que les paires consécutives.
 */
export function getOccupationGaps(
  timeline: SiteTimeline | undefined,
): YearInterval[] {
  const entries = timeline?.site_type?.entries;
  if (!entries?.length) return [];
  const sorted = [...entries].sort((a, b) => a.from - b.from);
  const gaps: YearInterval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const e = sorted[i];
    const next = sorted[i + 1];
    if (e.to != null && e.to < next.from) {
      gaps.push({ from: e.to, to: next.from });
    }
  }
  return gaps;
}

// ── Plage temporelle ──────────────────────────────────────────────────────────

/**
 * Bornes brutes des données d'une timeline : la plus ancienne année mentionnée et
 * la plus récente (en tenant compte des `to`, qui peuvent dépasser le dernier
 * `from` — une religion fermée en 1453 sur un site dont la dernière entrée est
 * antérieure).
 *
 * Passe par TRACK_KEYS : toute piste ajoutée est prise en compte automatiquement.
 */
export function getTimelineBounds(
  timeline: SiteTimeline | undefined,
): { min: number; max: number } | null {
  const entries = allTrackEntries(timeline);
  const years: number[] = entries.map((e) => e.from);
  for (const e of entries) if (e.to != null) years.push(e.to);
  if (timeline?.events) years.push(...timeline.events.map((e) => e.year));
  if (!years.length) return null;
  return { min: Math.min(...years), max: Math.max(...years) };
}

// ── Calcul inception / dissolution depuis la timeline ────────────────────────

/**
 * Année de première activité humaine, depuis la timeline.
 * Minimum de toutes les entrées de TOUTES les pistes et des événements.
 * Plus fiable que Wikidata (P571) : reflète la première trace d'occupation, pas
 * la "fondation officielle".
 */
export function computeInceptionFromTimeline(
  timeline: SiteTimeline,
): number | null {
  const froms = allTrackEntries(timeline).map((e) => e.from);
  if (timeline.events) froms.push(...timeline.events.map((e) => e.year));
  return froms.length ? Math.min(...froms) : null;
}

/**
 * Année de dissolution, depuis la timeline. Ordre de priorité :
 *   1. `to` explicite sur la DERNIÈRE entrée site_type ⇒ fin d'occupation sans
 *      réoccupation ultérieure (par construction, last n'a pas de successeur).
 *   2. Dernier état site_type terminal ("abandoned"/"ruins") ⇒ son `from`.
 *   3. Événement terminal le plus récent, si aucune activité connue après lui
 *      dans TOUTES les pistes.
 * Retourne null si le site est encore actif ou indéterminable.
 *
 * Un `to` INTERMÉDIAIRE (suivi d'une réoccupation) n'est JAMAIS une dissolution —
 * il n'est lu que par isInOccupationGap. Seul le `to` final l'est.
 *
 * Note : le `to` des pistes co-occurrentes (disparition d'une religion) n'entre
 * PAS dans ce calcul. Une religion qui s'éteint ne dissout pas le site.
 */
export function computeDissolutionFromTimeline(
  timeline: SiteTimeline,
): number | null {
  const TERMINAL_STATES: (SiteType | string)[] = ["abandoned", "ruins"];

  const entries = timeline.site_type?.entries ?? [];
  if (!entries.length) return null;

  const sorted = [...entries].sort((a, b) => a.from - b.from);
  const last = sorted[sorted.length - 1];

  // 1. Fin d'occupation explicite sur la dernière entrée.
  if (last.to != null) return last.to;

  // 2. Dernier état terminal.
  if (TERMINAL_STATES.includes(last.value as string)) return last.from;

  // 3. Événements terminaux.
  const TERMINAL_EVENTS = ["abandonment", "expulsion", "depopulation"];
  const terminalEvents = (timeline.events ?? [])
    .filter((e) => TERMINAL_EVENTS.includes(e.type))
    .sort((a, b) => b.year - a.year);

  if (terminalEvents.length) {
    const latestEvent = terminalEvents[0];
    // Seulement si aucune activité connue après l'événement, toutes pistes confondues.
    const hasActivityAfter = allTrackEntries(timeline).some(
      (e) => e.from > latestEvent.year,
    );
    if (!hasActivityAfter) return latestEvent.year;
  }

  return null;
}

// ── Résolution de l'état courant ─────────────────────────────────────────────

/**
 * site_type effectif à l'année donnée.
 * Priorité : timeline > site_type statique Wikidata > "settlement"
 */
export function getSiteTypeAt(
  entry: SiteEntry,
  year: number,
): SiteType | string {
  const v = getValueAt(entry.timeline?.site_type, year);
  return v ?? entry.site_type ?? "settlement";
}

/** Site actif (non abandonné, hors hiatus) à l'année donnée ? */
export function siteVisible(
  entry: SiteEntry,
  year: number,
  showUndated: boolean,
): boolean {
  const tl = entry.timeline;

  if (tl) {
    const bounds = getTimelineBounds(tl);
    if (bounds && year < bounds.min) return false;

    // Hiatus d'occupation explicite ⇒ invisible pendant le trou.
    if (isInOccupationGap(tl, year)) return false;

    const siteType = getSiteTypeAt(entry, year);
    if (siteType === "abandoned") return false;
    if (entry.dissolution && year > entry.dissolution.year) return false;
    return true;
  }

  // Fallback sans timeline — exiger une inception explicite
  if (entry.inception == null) return showUndated;
  const start = entry.inception.year;
  const end = entry.dissolution?.year ?? Infinity;
  return year >= start && year <= end;
}

// ── Calcul d'importance ───────────────────────────────────────────────────────

const TYPE_SCORES: Partial<Record<SiteType | string, number>> = {
  capital: 100,
  capital_city: 100,
  metropolis: 90,
  city: 75,
  religious_site: 65,
  fortress: 60,
  port: 60,
  town: 50,
  colony: 45,
  administrative: 40,
  village: 30,
  settlement: 20,
  campsite: 10,
  ruins: 35,
  abandoned: 15,
};

/** Score d'importance dynamique (0-100) pour un site à une année donnée. */
export function computeImportance(entry: SiteEntry, year: number): number {
  const siteType = getSiteTypeAt(entry, year);
  const typeScore = TYPE_SCORES[siteType] ?? 20;

  const pop = getValueAt(entry.timeline?.population, year);
  const popScore =
    pop != null
      ? Math.min(30, Math.floor(Math.log10(Math.max(pop, 1)) * 8))
      : 0;

  const hasTimeline = entry.timeline ? 10 : 0;
  const hasEvents = (entry.timeline?.events?.length ?? 0) > 0 ? 5 : 0;

  return Math.min(100, typeScore + popScore + hasTimeline + hasEvents);
}

/** Mapping zoom Leaflet → seuil de score minimum pour l'affichage. */
export const ZOOM_THRESHOLDS: Record<number, number> = {
  2: 95,
  3: 90,
  4: 85,
  5: 75,
  6: 65,
  7: 55,
  8: 45,
  9: 35,
  10: 20,
  11: 10,
  12: 0,
};

export function getZoomThreshold(zoom: number): number {
  const z = Math.min(12, Math.max(2, Math.floor(zoom)));
  return ZOOM_THRESHOLDS[z] ?? 0;
}

export const MAX_MARKERS = 500;

// ── Conversion de valeur de piste en string affichable ───────────────────────

/**
 * Convertit n'importe quelle valeur de TrackEntry en string affichable.
 * Gère : string, number, EntityRef { name }, NameEntry { text }.
 */
export function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    if ("name" in (v as any)) return (v as any).name as string;
    if ("text" in (v as any)) return (v as any).text as string;
  }
  return String(v ?? "");
}

/** Libellé d'une entrée de piste, rôle compris s'il y en a un. */
export function formatTrackEntry(key: TrackKey, e: TrackEntry<any>): string {
  const v = e.value as any;
  let base: string;
  switch (key) {
    case "site_type":
      base = String(v).replace(/_/g, " ");
      break;
    case "name":
      base = `${v?.text ?? v}${v?.lang ? ` (${v.lang})` : ""}`;
      break;
    case "population":
      base = Number(v).toLocaleString();
      break;
    default:
      base = toStr(v);
  }
  return TRACK_META[key].hasRole && e.role ? `${base} · ${e.role}` : base;
}

// ── Formatage des dates ───────────────────────────────────────────────────────

export function formatYear(
  wd: { year: number; precision: number; circa?: boolean } | null | undefined,
): string | null {
  if (!wd) return null;
  const abs = Math.abs(wd.year);
  const era = wd.year < 0 ? " BC" : " AD";
  const pfx = wd.circa ? "c. " : "";
  if (wd.precision <= 6) return `${pfx}${Math.ceil(abs / 1000)}th mill.${era}`;
  if (wd.precision === 7) return `${pfx}${Math.ceil(abs / 100)}th c.${era}`;
  if (wd.precision === 8) return `${pfx}${Math.floor(abs / 10) * 10}s${era}`;
  return `${pfx}${abs}${era}`;
}
