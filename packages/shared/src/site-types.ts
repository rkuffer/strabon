// =============================================================================
// site-types.ts — Types partagés Strabon
// Importé par @strabon/db, @strabon/server, @strabon/scripts
// =============================================================================

// ── Primitives géographiques et temporelles ───────────────────────────────────

export type Coordinates = {
  lat: number;
  lon: number;
  precision?: number;
  type?: string;
};

export type WikiDate = {
  year: number; // négatif = avant J.-C.
  precision: number; // 6=millénaire 7=siècle 8=décennie 9=année
  circa?: boolean;
};

// ── Classification des types de site ─────────────────────────────────────────

export type SiteType =
  | "campsite"
  | "settlement"
  | "village"
  | "town"
  | "city"
  | "metropolis"
  | "capital"
  | "capital_city"
  | "religious_site"
  | "fortress"
  | "port"
  | "colony"
  | "administrative"
  | "ruins"
  | "abandoned";

// ── Entités de référence ──────────────────────────────────────────────────────

// Entité politique avec QID obligatoire
// wikidata : QID Wikidata ("Q2277") ou identifiant local ("local_canaan")
export type PolityEntry = {
  name: string;
  wikidata: string;
};

// Culture archéologique/civilisation avec QID obligatoire
export type CultureEntry = {
  name: string;
  wikidata: string;
};

// Nom vernaculaire avec langue
export type NameEntry = {
  text: string;
  lang?: string; // ISO 639 : "hbo", "grc", "la", "ar", "akk"...
};

// ── Timeline — Modèle A (pistes indépendantes) ────────────────────────────────

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

// ── Événements ponctuels ──────────────────────────────────────────────────────

export type EventType =
  | "destruction"
  | "fire"
  | "earthquake"
  | "flood"
  | "plague"
  | "siege"
  | "conquest"
  | "founding"
  | "refounding"
  | "abandonment"
  | "expulsion"
  | "depopulation";

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

// ── SiteTimeline ──────────────────────────────────────────────────────────────

export type SiteTimeline = {
  site_type?: Track<SiteType>;
  polity?: Track<PolityEntry>;
  culture?: Track<CultureEntry>;
  name?: Track<NameEntry>;
  population?: Track<number>;
  events?: PointEvent[];
};

// ── SiteEntry ─────────────────────────────────────────────────────────────────

export type SiteEntry = {
  // Identification
  id: string;
  wikipedia_page_en_url: string;
  last_updated: string;
  source: string;
  wikidata_id?: string;

  // Géographie
  coordinates?: Coordinates;
  country?: string;
  country_qid?: string;

  // Identité Wikidata
  description?: string;
  names?: Record<string, string>;
  native_label?: string;

  // Temporel
  inception?: WikiDate;
  dissolution?: WikiDate;

  // Classification Wikidata (héritage)
  cultures?: string[];
  site_type?: string;

  // Importance statique (taille article Wikipedia, proxy notoriété)
  // Persisté en base, calculé par enricher depuis batchIsArticlePage
  base_importance?: number; // 0-100

  // Enrichissement
  wikidata_enriched_at?: string;

  // Timeline LLM
  timeline?: SiteTimeline;
  timeline_extracted_at?: string;
  timeline_extraction_model?: string;
};

export type Index = Record<string, SiteEntry>;

// ── WikidataEnrichment — résultat intermédiaire batch Wikidata ────────────────

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

// ── Entités de référence (tables polities / cultures) ─────────────────────────

export type Polity = {
  wikidata_id: string; // QID ou "local_xxx" — clé primaire
  name: string;
  type?:
    | "empire"
    | "kingdom"
    | "republic"
    | "city-state"
    | "caliphate"
    | "tribe"
    | "other";
  color?: string; // hex — couleur d'affichage sur la carte
  wikipedia_url?: string;
};

export type Culture = {
  wikidata_id: string; // QID ou "local_xxx" — clé primaire
  name: string;
  type?: "archaeological_culture" | "civilization" | "period" | "religion";
  color?: string;
  wikipedia_url?: string;
};

// ── API response types (partagés server ↔ web) ────────────────────────────────

// État courant d'un site résolu à une année donnée — retourné par GET /api/sites
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

// Polygone d'une polity/culture à une année donnée — retourné par GET /api/hulls
export type HullFeature = {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][];
  };
  properties: {
    id: string; // wikidata_id de la polity/culture
    name: string;
    color: string;
    kind: "polity" | "culture";
    site_count: number;
  };
};

// Résultat de recherche par nom — retourné par GET /api/search
export type SiteSearchResult = {
  id: string;
  title: string;
  lat: number;
  lon: number;
  country: string | null;
  score: number;
};
