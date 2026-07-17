export type Coordinates = {
    lat: number;
    lon: number;
    precision?: number;
    type?: string;
};
export type WikiDate = {
    year: number;
    precision: number;
    circa?: boolean;
};
export type SiteType = "campsite" | "settlement" | "village" | "town" | "city" | "metropolis" | "capital" | "capital_city" | "religious_site" | "fortress" | "port" | "colony" | "administrative" | "ruins" | "abandoned";
/**
 * Entité identifiée par un QID Wikidata.
 *
 * `wikidata` est OPTIONNEL : le prompt d'extraction ordonne explicitement
 * d'omettre le champ quand le QID n'est pas certain ("a WRONG QID is worse than
 * NO QID"). Une entrée sans QID reste parfaitement valide et s'affiche par son
 * nom seul ; elle est simplement exclue des référentiels et du calcul des hulls.
 * Les entités absentes du référentiel sont par ailleurs signalées dans
 * `SiteTimeline.missing_entities`.
 */
export type EntityRef = {
    name: string;
    wikidata?: string;
};
export type PolityEntry = EntityRef;
export type CultureEntry = EntityRef;
export type ReligionEntry = EntityRef;
export type LanguageEntry = EntityRef;
export type NameEntry = {
    text: string;
    lang?: string;
};
/**
 * Rôle d'une religion ou d'une langue à un moment donné.
 * Ordonné du plus dominant au plus marginal — voir ROLE_ORDER.
 */
export type RoleQualifier = "state" | "major" | "minor" | "minority";
export declare const ROLE_ORDER: readonly RoleQualifier[];
/** Rang d'un rôle pour le tri (0 = le plus dominant). Inconnu ⇒ dernier. */
export declare function roleRank(role: RoleQualifier | undefined): number;
export type Confidence = "high" | "medium" | "low";
export type TrackEntry<T> = {
    from: number;
    from_precision?: number;
    from_circa?: boolean;
    /**
     * Borne de fin OPTIONNELLE. Sa sémantique dépend du RÉGIME de la piste
     * (voir TRACK_META.regime) :
     *
     * — Pistes ESCALIER (polity, culture, name, population) —
     *   `to` n'a AUCUN sens et ne doit jamais être émis. Chaque entrée est fermée
     *   par la suivante de la même piste. Une polity est toujours remplacée par une
     *   autre, jamais par le vide.
     *
     * — Piste OCCUPATION (site_type) —
     *   `to` marque la fin réelle d'une période d'occupation (hiatus / abandon),
     *   PAS une simple incertitude d'attestation. N'a de sens que s'il existe une
     *   entrée site_type ultérieure (réoccupation) ; un `to` final sans successeur
     *   ≡ dissolution.
     *   Lu par : isInOccupationGap / getOccupationGaps / computeDissolutionFromTimeline
     *   / siteVisible, et leur miroir SQL site_occupied_at().
     *
     * — Pistes CO-OCCURRENTES (religion, language) —
     *   `to` marque la DISPARITION de l'entité (la religion romaine s'éteint après
     *   la christianisation). Il est indispensable ici : sur une piste co-occurrente,
     *   l'entrée suivante n'écrase pas la précédente, elle s'ajoute — rien ne peut
     *   donc fermer une entrée implicitement, sauf une entrée ultérieure portant la
     *   MÊME entité (changement de rôle : christianisme minority → state).
     *   Absent ⇒ l'entité reste présente jusqu'à sa prochaine entrée de même
     *   identité, ou jusqu'à la fin de la timeline.
     *
     * NB : les timelines extraites avant l'élargissement du `to` n'en portent aucun
     * sur religion/language (normalizeTimelineV2 le supprimait). La fermeture par
     * entité les rend correctement affichables sans migration.
     */
    to?: number | null;
    value: T;
    /**
     * Rôle — pistes CO-OCCURRENTES uniquement (religion, language).
     * Ignoré sur les autres pistes.
     */
    role?: RoleQualifier;
    confidence?: Confidence;
    sources?: string[];
    notes?: string;
};
export type Track<T> = {
    entries: TrackEntry<T>[];
};
export type EventType = "destruction" | "fire" | "earthquake" | "flood" | "plague" | "siege" | "conquest" | "massacre" | "founding" | "refounding" | "abandonment" | "expulsion" | "depopulation" | "revolution" | "annexation" | "discovery";
export type PointEvent = {
    year: number;
    year_precision?: number;
    year_circa?: boolean;
    type: EventType;
    cause?: string;
    perpetrator?: string;
    perpetrator_wikidata?: string;
    description?: string;
    confidence?: Confidence;
    sources?: string[];
};
export type MissingEntityKind = "polity" | "culture" | "religion" | "language";
/**
 * Entité rencontrée par l'extraction mais absente du référentiel
 * `wikidata_entities`. `name` est la clé de réconciliation avec l'entrée de piste
 * correspondante (qui porte le même `name` sans `wikidata`).
 * `proposed_qid` est une HYPOTHÈSE, vérifiée contre Wikidata avant tout usage.
 */
export type MissingEntity = {
    kind: MissingEntityKind;
    name: string;
    context?: string;
    proposed_qid?: string;
};
export type SiteTimeline = {
    site_type?: Track<SiteType>;
    polity?: Track<PolityEntry>;
    culture?: Track<CultureEntry>;
    religion?: Track<ReligionEntry>;
    language?: Track<LanguageEntry>;
    name?: Track<NameEntry>;
    population?: Track<number>;
    events?: PointEvent[];
    missing_entities?: MissingEntity[];
};
/** Résultat d'extraction quand l'article ne décrit pas un lieu habité. */
export type TimelineRejection = {
    rejection: {
        reason: string;
        entity_type?: string;
    };
};
export type TrackKey = "site_type" | "polity" | "culture" | "religion" | "language" | "name" | "population";
/**
 * Régime de fermeture d'une piste :
 * - "step"        : escalier — chaque entrée est fermée par la suivante.
 * - "occupation"  : escalier + `to` = hiatus d'occupation (site_type).
 * - "cooccurrent" : plusieurs entrées actives simultanément, fermeture par
 *                   entité ou par `to` explicite (religion, language).
 */
export type TrackRegime = "step" | "occupation" | "cooccurrent";
export type TrackMeta = {
    key: TrackKey;
    /** Libellé court affiché dans la frise et les vues admin. */
    label: string;
    regime: TrackRegime;
    /** La piste porte-t-elle un qualificatif de rôle ? */
    hasRole: boolean;
    /**
     * Une entrée de cette piste peut-elle être fermée EXPLICITEMENT par un `to` ?
     *
     * Le régime reste `step` — une nouvelle entrée ferme toujours implicitement la
     * précédente. On ajoute la fermeture explicite : celle qui dit « et après, plus
     * rien ». Sans elle, la dernière entrée d'une piste escalier court jusqu'à la
     * fin de l'occupation, et le silence CORRECT du modèle (« l'histoire documentée
     * commence, je m'arrête ») devient une affirmation FAUSSE au rendu : la culture
     * mérovingienne règne sur la France en 1990, le Royaume d'Italie sur Milan.
     *
     * `name` et `population` ne sont PAS closables : un nom n'est pas *fermé*, il
     * est *remplacé*. Une population non plus.
     */
    closable: boolean;
};
/** Ordre narratif des pistes — utilisé tel quel pour le rendu. */
export declare const TRACK_KEYS: readonly TrackKey[];
export declare const TRACK_META: Record<TrackKey, TrackMeta>;
/** Pistes dont une entrée peut être fermée explicitement par un `to`. */
export declare const CLOSABLE_TRACK_KEYS: readonly TrackKey[];
export declare function isClosable(key: TrackKey): boolean;
/** Pistes admettant plusieurs valeurs actives simultanément. */
export declare const COOCCURRENT_TRACK_KEYS: readonly TrackKey[];
export declare function isCooccurrent(key: TrackKey): boolean;
export type SiteEntry = {
    id: string;
    wikipedia_page_en_url: string;
    last_updated: string;
    source: string;
    wikidata_id?: string;
    coordinates?: Coordinates;
    country?: string;
    country_qid?: string;
    description?: string;
    names?: Record<string, string>;
    native_label?: string;
    inception?: WikiDate;
    dissolution?: WikiDate;
    cultures?: string[];
    site_type?: string;
    base_importance?: number;
    wikidata_enriched_at?: string;
    timeline?: SiteTimeline;
    timeline_extracted_at?: string;
    timeline_extraction_model?: string;
};
export type Index = Record<string, SiteEntry>;
export type WikidataEnrichment = {
    coordinates?: Coordinates;
    country?: string;
    country_qid?: string;
    names?: Record<string, string>;
    native_label?: string;
    inception?: WikiDate;
    dissolution?: WikiDate;
    cultures?: string[];
    site_type?: string;
};
export type Polity = {
    wikidata_id: string;
    name: string;
    type?: "empire" | "kingdom" | "republic" | "city-state" | "caliphate" | "tribe" | "other";
    color?: string;
    wikipedia_url?: string;
};
export type Culture = {
    wikidata_id: string;
    name: string;
    type?: "archaeological_culture" | "civilization" | "period" | "religion";
    color?: string;
    wikipedia_url?: string;
};
export type SiteState = {
    id: string;
    title: string;
    lat: number;
    lon: number;
    site_type: SiteType | string;
    polity?: PolityEntry;
    culture?: CultureEntry;
    base_importance: number;
    computed_importance: number;
    has_timeline: boolean;
};
/**
 * Dimension pouvant être rendue en hulls sur la carte.
 * L'utilisateur en choisit UNE à la fois (sélecteur flottant) — l'empilement de
 * plusieurs dimensions simultanées était illisible.
 */
export type HullKind = "polity" | "culture" | "religion" | "language";
export declare const HULL_KINDS: readonly HullKind[];
export type HullFeature = {
    type: "Feature";
    geometry: {
        type: "Polygon" | "MultiPolygon";
        coordinates: number[][][];
    };
    properties: {
        id: string;
        name: string;
        kind: HullKind;
        site_count: number;
        color: string;
        stroke: string;
        family_qid: string | null;
        family_label: string | null;
        top_role: RoleQualifier | null;
    };
};
export type SiteSearchResult = {
    id: string;
    title: string;
    lat: number;
    lon: number;
    country: string | null;
    score: number;
};
//# sourceMappingURL=site-types.d.ts.map