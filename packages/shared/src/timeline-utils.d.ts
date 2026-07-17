import type { Track, TrackEntry, TrackKey, SiteEntry, SiteTimeline, SiteType, RoleQualifier } from "./site-types.js";
/**
 * Retourne la piste `key` d'une timeline, sans présumer de son type.
 * Point de passage unique : évite les listes de pistes écrites en dur, qui
 * faisaient silencieusement disparaître une dimension des calculs.
 */
export declare function getTrack(timeline: SiteTimeline | undefined, key: TrackKey): Track<any> | undefined;
/** Toutes les entrées de toutes les pistes, dans l'ordre de TRACK_KEYS. */
export declare function allTrackEntries(timeline: SiteTimeline | undefined): TrackEntry<any>[];
/** Les pistes non vides d'une timeline, dans l'ordre narratif. */
export declare function presentTrackKeys(timeline: SiteTimeline | undefined): TrackKey[];
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
export declare function entityKey(value: unknown): string;
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
export declare function getValueAt<T>(track: Track<T> | undefined, year: number, opts?: {
    honorTo?: boolean;
}): T | null;
/** Entrée complète (from, confidence, notes…) active à l'année donnée.
 *
 * `honorTo` — par défaut FAUX, et ce n'est pas une négligence.
 * `isInOccupationGap()` s'appuie sur cette fonction pour lire le `to` de
 * site_type elle-même : si getEntryAt honorait le `to` globalement, elle
 * renverrait null pendant un hiatus et la détection des trous s'effondrerait.
 * Les deux préoccupations restent orthogonales (cf. en-tête du fichier).
 *
 * Sur une piste CLOSABLE (polity, culture), passer `honorTo: true` — sinon la
 * dernière entrée court jusqu'à la fin de l'occupation.
 */
export declare function getEntryAt<T>(track: Track<T> | undefined, year: number, opts?: {
    honorTo?: boolean;
}): TrackEntry<T> | null;
/**
 * Lecture d'une piste par sa CLÉ — honore automatiquement le `to` si la piste est
 * closable. C'est le point d'entrée à préférer : il ne demande pas à l'appelant de
 * savoir quel régime porte quelle piste, et TRACK_META reste la source unique.
 */
export declare function getTrackEntryAt<T>(timeline: SiteTimeline | undefined, key: TrackKey, year: number): TrackEntry<T> | null;
/** Toutes les entrées d'une piste jusqu'à `yearTo`. */
export declare function getEntriesInRange<T>(track: Track<T> | undefined, yearFrom: number, yearTo: number): TrackEntry<T>[];
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
export declare function getActiveEntriesAt<T>(track: Track<T> | undefined, year: number): TrackEntry<T>[];
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
export declare function buildLanes<T>(track: Track<T> | undefined, endYear: number): EntityLane<T>[];
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
 */
export declare function isInOccupationGap(timeline: SiteTimeline | undefined, year: number): boolean;
/**
 * Trous d'occupation (hiatus) sous forme d'intervalles (to, next.from), déduits
 * de la piste site_type. Un `to` sans entrée suivante n'est PAS un trou (c'est une
 * dissolution) — on n'inspecte que les paires consécutives.
 */
export declare function getOccupationGaps(timeline: SiteTimeline | undefined): YearInterval[];
/**
 * Bornes brutes des données d'une timeline : la plus ancienne année mentionnée et
 * la plus récente (en tenant compte des `to`, qui peuvent dépasser le dernier
 * `from` — une religion fermée en 1453 sur un site dont la dernière entrée est
 * antérieure).
 *
 * Passe par TRACK_KEYS : toute piste ajoutée est prise en compte automatiquement.
 */
export declare function getTimelineBounds(timeline: SiteTimeline | undefined): {
    min: number;
    max: number;
} | null;
/**
 * Année de première activité humaine, depuis la timeline.
 * Minimum de toutes les entrées de TOUTES les pistes et des événements.
 * Plus fiable que Wikidata (P571) : reflète la première trace d'occupation, pas
 * la "fondation officielle".
 */
export declare function computeInceptionFromTimeline(timeline: SiteTimeline): number | null;
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
export declare function computeDissolutionFromTimeline(timeline: SiteTimeline): number | null;
/**
 * site_type effectif à l'année donnée.
 * Priorité : timeline > site_type statique Wikidata > "settlement"
 */
export declare function getSiteTypeAt(entry: SiteEntry, year: number): SiteType | string;
/** Site actif (non abandonné, hors hiatus) à l'année donnée ? */
export declare function siteVisible(entry: SiteEntry, year: number, showUndated: boolean): boolean;
/** Score d'importance dynamique (0-100) pour un site à une année donnée. */
export declare function computeImportance(entry: SiteEntry, year: number): number;
/**
 * Mapping zoom Leaflet → seuil de score minimum pour l'affichage.
 *
 * Calé sur la distribution réelle de `computed_importance` mesurée sur les
 * ~2,15 M sites (juillet 2026, après passage de base_importance en colonne
 * générée) : p50=32, p75=36, p90=42, p95=52, p99=61, max=159. 99 % des sites
 * tiennent dans la bande 20-61 (un site L0 sans timeline vaut 20 : le plancher).
 * Les seuils suivent donc les percentiles — haut (~p99) au monde entier pour
 * ne montrer que les sites très notables, jusqu'au plancher au zoom max où seul
 * le bruit base=0 (computed=20, points nus) reste masqué.
 *
 * Ce sont les molettes d'affichage : elles ne changent QUE la densité de
 * marqueurs par zoom, jamais le classement. À ajuster à l'œil sur carte.
 */
export declare const ZOOM_THRESHOLDS: Record<number, number>;
export declare function getZoomThreshold(zoom: number): number;
export declare const MAX_MARKERS = 500;
/**
 * Convertit n'importe quelle valeur de TrackEntry en string affichable.
 * Gère : string, number, EntityRef { name }, NameEntry { text }.
 */
export declare function toStr(v: unknown): string;
/** Libellé d'une entrée de piste, rôle compris s'il y en a un. */
export declare function formatTrackEntry(key: TrackKey, e: TrackEntry<any>): string;
export declare function formatYear(wd: {
    year: number;
    precision: number;
    circa?: boolean;
} | null | undefined): string | null;
/**
 * Année de fin d'occupation du site, ou null s'il est encore habité.
 *
 * Un site abandonné n'a plus ni polity, ni culture, ni langue, ni religion — parce
 * qu'il n'y a plus personne. C'est le symétrique de la règle d'attestation locale :
 * pas d'habitants, pas de dimension humaine.
 *
 * Sans cette borne, les pistes ESCALIER étirent leur dernière entrée jusqu'à la fin
 * des DONNÉES — et les données d'un site mort contiennent des entrées modernes qui
 * ne parlent pas de son occupation : un nom archéologique (Uruk redécouverte par
 * Loftus, "Warka", 1849), une fouille, un classement patrimonial. Résultat observé :
 * la culture "Sumer" courait jusqu'en 1849.
 *
 * On lit UNIQUEMENT site_type, qui est la seule piste qui parle d'occupation. Un `to`
 * final ou un état terminal (abandoned/ruins) ferme le site ; une entrée ultérieure
 * de site_type le rouvre (réoccupation).
 */
export declare function getOccupationEnd(timeline: SiteTimeline | undefined): number | null;
//# sourceMappingURL=timeline-utils.d.ts.map