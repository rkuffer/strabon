import type { Track, TrackEntry, SiteEntry, SiteTimeline, SiteType } from "./site-types.js";
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
export declare function getValueAt<T>(track: Track<T> | undefined, year: number): T | null;
/**
 * Retourne l'entrée complète (avec from, confidence, notes...) active à l'année donnée.
 */
export declare function getEntryAt<T>(track: Track<T> | undefined, year: number): TrackEntry<T> | null;
/**
 * Retourne toutes les entrées d'une piste dans un intervalle [yearFrom, yearTo].
 */
export declare function getEntriesInRange<T>(track: Track<T> | undefined, yearFrom: number, yearTo: number): TrackEntry<T>[];
export type YearInterval = {
    from: number;
    to: number;
};
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
export declare function isInOccupationGap(timeline: SiteTimeline | undefined, year: number): boolean;
/**
 * Retourne les trous d'occupation (hiatus) sous forme d'intervalles (to, next.from),
 * déduits de la piste site_type. Un `to` sans entrée suivante n'est PAS un trou
 * (c'est une dissolution) — on n'inspecte que les paires consécutives.
 * Destiné au rendu (TimelineTrack) et à toute logique de clipping.
 */
export declare function getOccupationGaps(timeline: SiteTimeline | undefined): YearInterval[];
/**
 * Calcule l'année de première activité humaine depuis la timeline.
 * Prend le minimum de toutes les entrées de toutes les pistes et événements.
 * Cette valeur est plus fiable que celle de Wikidata (P571) car elle reflète
 * la première trace d'occupation, pas la "fondation officielle".
 */
export declare function computeInceptionFromTimeline(timeline: SiteTimeline): number | null;
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
export declare function computeDissolutionFromTimeline(timeline: SiteTimeline): number | null;
/**
 * Retourne le site_type effectif à l'année donnée.
 * Priorité : timeline > site_type statique Wikidata > "settlement"
 */
export declare function getSiteTypeAt(entry: SiteEntry, year: number): SiteType | string;
/**
 * Détermine si un site est visible (actif, non abandonné, hors hiatus) à l'année donnée.
 */
export declare function siteVisible(entry: SiteEntry, year: number, showUndated: boolean): boolean;
/**
 * Score d'importance dynamique (0-100) pour un site à une année donnée.
 */
export declare function computeImportance(entry: SiteEntry, year: number): number;
/**
 * Mapping zoom Leaflet → seuil de score minimum pour l'affichage.
 */
export declare const ZOOM_THRESHOLDS: Record<number, number>;
export declare function getZoomThreshold(zoom: number): number;
export declare const MAX_MARKERS = 500;
/**
 * Convertit n'importe quelle valeur de TrackEntry en string affichable.
 * Gère : string, number, PolityEntry { name }, CultureEntry { name }, NameEntry { text }
 */
export declare function toStr(v: unknown): string;
export declare function formatYear(wd: {
    year: number;
    precision: number;
    circa?: boolean;
} | null | undefined): string | null;
//# sourceMappingURL=timeline-utils.d.ts.map