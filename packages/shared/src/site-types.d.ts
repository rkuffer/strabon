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
export type PolityEntry = {
    name: string;
    wikidata: string;
};
export type CultureEntry = {
    name: string;
    wikidata: string;
};
export type NameEntry = {
    text: string;
    lang?: string;
};
export type Confidence = "high" | "medium" | "low";
export type TrackEntry<T> = {
    from: number;
    from_precision?: number;
    from_circa?: boolean;
    /**
     * Borne de fin OPTIONNELLE — sémantiquement valide UNIQUEMENT sur la piste
     * site_type. Marque la fin réelle d'une période d'occupation (hiatus / abandon),
     * PAS une simple incertitude d'attestation.
     * - absent / null  ⇒ l'entrée reste active jusqu'à l'entrée suivante de la
     *   piste (comportement historique, fonction en escalier). Aucune migration.
     * - défini         ⇒ n'a de sens QUE s'il existe une entrée site_type
     *   ultérieure (réoccupation). Un `to` final sans successeur ≡ dissolution.
     * Lu par : isInOccupationGap / getOccupationGaps / computeDissolutionFromTimeline
     * / siteVisible, et leur miroir SQL site_occupied_at().
     */
    to?: number | null;
    value: T;
    confidence?: Confidence;
    sources?: string[];
    notes?: string;
};
export type Track<T> = {
    entries: TrackEntry<T>[];
};
export type EventType = "destruction" | "fire" | "earthquake" | "flood" | "plague" | "siege" | "conquest" | "founding" | "refounding" | "abandonment" | "expulsion" | "depopulation";
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
export type SiteTimeline = {
    site_type?: Track<SiteType>;
    polity?: Track<PolityEntry>;
    culture?: Track<CultureEntry>;
    name?: Track<NameEntry>;
    population?: Track<number>;
    events?: PointEvent[];
};
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
};
export type HullFeature = {
    type: "Feature";
    geometry: {
        type: "Polygon" | "MultiPolygon";
        coordinates: number[][][];
    };
    properties: {
        id: string;
        name: string;
        color: string;
        kind: "polity" | "culture";
        site_count: number;
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