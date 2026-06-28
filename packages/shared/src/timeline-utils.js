// =============================================================================
// timeline-utils.ts — Utilitaires de lecture des timelines (Modèle A)
// Partagés entre @strabon/server et @strabon/web
// =============================================================================
// ── Lecture d'une piste à une année donnée ────────────────────────────────────
/**
 * Retourne la valeur active d'une piste à l'année donnée.
 * Retourne null si aucune entrée n'est encore active (year < première entrée).
 *
 * NB : volontairement non "occupation-aware". Pendant un trou d'occupation
 * (site_type.to), cette fonction renvoie toujours la valeur de l'entrée qui a
 * fermé — le gating du trou est porté séparément par isInOccupationGap /
 * siteVisible (et son miroir SQL site_occupied_at). Les deux préoccupations
 * restent orthogonales, exactement comme côté SQL où track_value_at est intacte.
 */
export function getValueAt(track, year) {
    if (!track?.entries?.length)
        return null;
    const sorted = [...track.entries].sort((a, b) => a.from - b.from);
    let active = null;
    for (const e of sorted) {
        if (e.from <= year)
            active = e.value;
        else
            break;
    }
    return active;
}
/**
 * Retourne l'entrée complète (avec from, confidence, notes...) active à l'année donnée.
 */
export function getEntryAt(track, year) {
    if (!track?.entries?.length)
        return null;
    const sorted = [...track.entries].sort((a, b) => a.from - b.from);
    let active = null;
    for (const e of sorted) {
        if (e.from <= year)
            active = e;
        else
            break;
    }
    return active;
}
/**
 * Retourne toutes les entrées d'une piste dans un intervalle [yearFrom, yearTo].
 */
export function getEntriesInRange(track, yearFrom, yearTo) {
    if (!track?.entries?.length)
        return [];
    return [...track.entries]
        .sort((a, b) => a.from - b.from)
        .filter((e) => e.from <= yearTo);
}
/**
 * Indique si `year` tombe dans un trou d'occupation explicite.
 *
 * Miroir EXACT de la fonction SQL site_occupied_at (inversée) :
 *   active = dernière entrée site_type avec from <= year
 *   - pas d'entrée active (year avant la 1ʳᵉ)  ⇒ pas un trou (false)
 *   - active.to absent/null                    ⇒ ouvert jusqu'à la suivante (false)
 *   - year <= active.to                        ⇒ encore occupé (false)
 *   - year >  active.to                        ⇒ trou (true)
 *
 * Par construction, si l'entrée active a year > to, c'est qu'aucune réoccupation
 * (from <= year) n'a démarré : on est bien dans le hiatus, ou après une
 * dissolution terminale (que le bornage inception/dissolution gère aussi).
 */
export function isInOccupationGap(timeline, year) {
    const entries = timeline?.site_type?.entries;
    if (!entries?.length)
        return false;
    const sorted = [...entries].sort((a, b) => a.from - b.from);
    let active = null;
    for (const e of sorted) {
        if (e.from <= year)
            active = e;
        else
            break;
    }
    if (!active)
        return false; // avant la première entrée
    if (active.to == null)
        return false; // ouvert jusqu'à la suivante
    return year > active.to; // strictement après la fermeture ⇒ trou
}
/**
 * Retourne les trous d'occupation (hiatus) sous forme d'intervalles (to, next.from),
 * déduits de la piste site_type. Un `to` sans entrée suivante n'est PAS un trou
 * (c'est une dissolution) — on n'inspecte que les paires consécutives.
 * Destiné au rendu (TimelineTrack) et à toute logique de clipping.
 */
export function getOccupationGaps(timeline) {
    const entries = timeline?.site_type?.entries;
    if (!entries?.length)
        return [];
    const sorted = [...entries].sort((a, b) => a.from - b.from);
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        const e = sorted[i];
        const next = sorted[i + 1];
        if (e.to != null && e.to < next.from) {
            gaps.push({ from: e.to, to: next.from });
        }
    }
    return gaps;
}
// ── Calcul inception / dissolution depuis la timeline ────────────────────────
/**
 * Calcule l'année de première activité humaine depuis la timeline.
 * Prend le minimum de toutes les entrées de toutes les pistes et événements.
 * Cette valeur est plus fiable que celle de Wikidata (P571) car elle reflète
 * la première trace d'occupation, pas la "fondation officielle".
 */
export function computeInceptionFromTimeline(timeline) {
    const froms = [];
    for (const track of [
        timeline.site_type,
        timeline.polity,
        timeline.culture,
        timeline.name,
        timeline.population,
    ]) {
        if (track?.entries)
            froms.push(...track.entries.map((e) => e.from));
    }
    if (timeline.events)
        froms.push(...timeline.events.map((e) => e.year));
    return froms.length ? Math.min(...froms) : null;
}
/**
 * Calcule l'année de dissolution depuis la timeline.
 * Ordre de priorité :
 *   1. `to` explicite sur la DERNIÈRE entrée site_type ⇒ fin d'occupation sans
 *      réoccupation ultérieure (par construction, last n'a pas de successeur).
 *   2. Dernier état site_type terminal ("abandoned"/"ruins") ⇒ son `from`.
 *   3. Événement terminal le plus récent, si aucune activité connue après lui
 *      dans TOUTES les pistes.
 * Retourne null si le site est encore actif ou indéterminable.
 *
 * Important : un `to` INTERMÉDIAIRE (suivi d'une réoccupation) n'est JAMAIS une
 * dissolution — il n'est lu que par isInOccupationGap. Seul le `to` final l'est.
 */
export function computeDissolutionFromTimeline(timeline) {
    const TERMINAL_STATES = ["abandoned", "ruins"];
    const entries = timeline.site_type?.entries ?? [];
    if (!entries.length)
        return null;
    const sorted = [...entries].sort((a, b) => a.from - b.from);
    const last = sorted[sorted.length - 1];
    // 1. Fin d'occupation explicite sur la dernière entrée.
    if (last.to != null)
        return last.to;
    // 2. Dernier état terminal.
    if (TERMINAL_STATES.includes(last.value)) {
        return last.from;
    }
    // 3. Événements terminaux.
    const TERMINAL_EVENTS = ["abandonment", "expulsion", "depopulation"];
    const terminalEvents = (timeline.events ?? [])
        .filter((e) => TERMINAL_EVENTS.includes(e.type))
        .sort((a, b) => b.year - a.year);
    if (terminalEvents.length) {
        // Seulement si pas d'activité connue après l'événement dans TOUTES les tracks
        const latestEvent = terminalEvents[0];
        const allEntries = [
            ...(timeline.site_type?.entries ?? []),
            ...(timeline.polity?.entries ?? []),
            ...(timeline.culture?.entries ?? []),
            ...(timeline.name?.entries ?? []),
            ...(timeline.population?.entries ?? []),
        ];
        const hasActivityAfter = allEntries.some((e) => e.from > latestEvent.year);
        if (!hasActivityAfter)
            return latestEvent.year;
    }
    return null;
}
// ── Résolution de l'état courant ─────────────────────────────────────────────
/**
 * Retourne le site_type effectif à l'année donnée.
 * Priorité : timeline > site_type statique Wikidata > "settlement"
 */
export function getSiteTypeAt(entry, year) {
    const tl = entry.timeline;
    if (tl?.site_type) {
        const v = getValueAt(tl.site_type, year);
        if (v)
            return v;
    }
    return entry.site_type ?? "settlement";
}
/**
 * Détermine si un site est visible (actif, non abandonné, hors hiatus) à l'année donnée.
 */
export function siteVisible(entry, year, showUndated) {
    const tl = entry.timeline;
    if (tl) {
        const allFroms = [];
        for (const track of [
            tl.site_type,
            tl.polity,
            tl.culture,
            tl.name,
            tl.population,
        ]) {
            if (track?.entries)
                allFroms.push(...track.entries.map((e) => e.from));
        }
        if (tl.events)
            allFroms.push(...tl.events.map((e) => e.year));
        const firstFrom = allFroms.length ? Math.min(...allFroms) : null;
        if (firstFrom !== null && year < firstFrom)
            return false;
        // Hiatus d'occupation explicite ⇒ invisible pendant le trou.
        if (isInOccupationGap(tl, year))
            return false;
        const siteType = getSiteTypeAt(entry, year);
        if (siteType === "abandoned")
            return false;
        if (entry.dissolution && year > entry.dissolution.year)
            return false;
        return true;
    }
    // Fallback sans timeline — exiger une inception explicite
    if (entry.inception == null)
        return showUndated;
    const start = entry.inception.year;
    const end = entry.dissolution?.year ?? Infinity;
    return year >= start && year <= end;
}
// ── Calcul d'importance ───────────────────────────────────────────────────────
const TYPE_SCORES = {
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
/**
 * Score d'importance dynamique (0-100) pour un site à une année donnée.
 */
export function computeImportance(entry, year) {
    const siteType = getSiteTypeAt(entry, year);
    const typeScore = TYPE_SCORES[siteType] ?? 20;
    const pop = getValueAt(entry.timeline?.population, year);
    const popScore = pop != null
        ? Math.min(30, Math.floor(Math.log10(Math.max(pop, 1)) * 8))
        : 0;
    const hasTimeline = entry.timeline ? 10 : 0;
    const hasEvents = (entry.timeline?.events?.length ?? 0) > 0 ? 5 : 0;
    return Math.min(100, typeScore + popScore + hasTimeline + hasEvents);
}
/**
 * Mapping zoom Leaflet → seuil de score minimum pour l'affichage.
 */
export const ZOOM_THRESHOLDS = {
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
export function getZoomThreshold(zoom) {
    const z = Math.min(12, Math.max(2, Math.floor(zoom)));
    return ZOOM_THRESHOLDS[z] ?? 0;
}
export const MAX_MARKERS = 500;
// ── Conversion de valeur de piste en string affichable ───────────────────────
/**
 * Convertit n'importe quelle valeur de TrackEntry en string affichable.
 * Gère : string, number, PolityEntry { name }, CultureEntry { name }, NameEntry { text }
 */
export function toStr(v) {
    if (typeof v === "string")
        return v;
    if (typeof v === "number")
        return String(v);
    if (v && typeof v === "object") {
        if ("name" in v)
            return v.name;
        if ("text" in v)
            return v.text;
    }
    return String(v ?? "");
}
// ── Formatage des dates ───────────────────────────────────────────────────────
export function formatYear(wd) {
    if (!wd)
        return null;
    const abs = Math.abs(wd.year);
    const era = wd.year < 0 ? " BC" : " AD";
    const pfx = wd.circa ? "c. " : "";
    if (wd.precision <= 6)
        return `${pfx}${Math.ceil(abs / 1000)}th mill.${era}`;
    if (wd.precision === 7)
        return `${pfx}${Math.ceil(abs / 100)}th c.${era}`;
    if (wd.precision === 8)
        return `${pfx}${Math.floor(abs / 10) * 10}s${era}`;
    return `${pfx}${abs}${era}`;
}
//# sourceMappingURL=timeline-utils.js.map