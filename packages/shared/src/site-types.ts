// =============================================================================
// site-types.ts — Types partagés Strabon
// Importé par @strabon/db, @strabon/server, @strabon/scripts, @strabon/web
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

// Entité politique (empire, royaume, cité-État…)
export type PolityEntry = EntityRef;

// Culture archéologique / civilisation
export type CultureEntry = EntityRef;

// Religion pratiquée sur le site
export type ReligionEntry = EntityRef;

// Langue parlée sur le site
export type LanguageEntry = EntityRef;

// Nom vernaculaire avec langue
export type NameEntry = {
  text: string;
  lang?: string; // ISO 639 : "hbo", "grc", "la", "ar", "akk"...
};

// ── Qualificatif de rôle (pistes co-occurrentes) ─────────────────────────────

/**
 * Rôle d'une religion ou d'une langue à un moment donné.
 * Ordonné du plus dominant au plus marginal — voir ROLE_ORDER.
 */
export type RoleQualifier = "state" | "major" | "minor" | "minority";

export const ROLE_ORDER: readonly RoleQualifier[] = [
  "state",
  "major",
  "minor",
  "minority",
];

/** Rang d'un rôle pour le tri (0 = le plus dominant). Inconnu ⇒ dernier. */
export function roleRank(role: RoleQualifier | undefined): number {
  const i = role ? ROLE_ORDER.indexOf(role) : -1;
  return i === -1 ? ROLE_ORDER.length : i;
}

// ── Timeline — Modèle A (pistes indépendantes) ────────────────────────────────

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

// ── Événements ponctuels ──────────────────────────────────────────────────────

export type EventType =
  | "destruction"
  | "fire"
  | "earthquake"
  | "flood"
  | "plague"
  | "siege"
  | "conquest"
  | "massacre"
  | "founding"
  | "refounding"
  | "abandonment"
  | "expulsion"
  | "depopulation"
  | "revolution"
  | "annexation"
  | "discovery";

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

// ── Lacunes du référentiel (signalées par l'extraction) ──────────────────────

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

// ── SiteTimeline ──────────────────────────────────────────────────────────────

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

// ── Métadonnées de pistes — source unique de vérité ──────────────────────────
//
// Toute itération sur les pistes DOIT passer par TRACK_KEYS / TRACK_META plutôt
// que par une liste écrite en dur. Une liste en dur oubliée quelque part fait
// silencieusement disparaître une dimension du calcul de plage temporelle,
// d'inception, de dissolution ou de visibilité.

export type TrackKey =
  | "site_type"
  | "polity"
  | "culture"
  | "religion"
  | "language"
  | "name"
  | "population";

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
export const TRACK_KEYS: readonly TrackKey[] = [
  "site_type",
  "polity",
  "culture",
  "religion",
  "language",
  "name",
  "population",
] as const;

export const TRACK_META: Record<TrackKey, TrackMeta> = {
  site_type: {
    key: "site_type",
    label: "TYPE",
    regime: "occupation",
    hasRole: false,
    // `to` = hiatus d'occupation. Lu par isInOccupationGap, PAS par la lecture
    // de valeur — les deux préoccupations restent orthogonales.
    closable: false,
  },
  polity: {
    key: "polity",
    label: "POLITY",
    regime: "step",
    hasRole: false,
    closable: true,
  },
  culture: {
    key: "culture",
    label: "CULTURE",
    regime: "step",
    hasRole: false,
    closable: true,
  },
  religion: {
    key: "religion",
    label: "RELIGION",
    regime: "cooccurrent",
    hasRole: true,
    closable: true,
  },
  language: {
    key: "language",
    label: "LANGUAGE",
    regime: "cooccurrent",
    hasRole: true,
    closable: true,
  },
  name: {
    key: "name",
    label: "NAME",
    regime: "step",
    hasRole: false,
    closable: false,
  },
  population: {
    key: "population",
    label: "POP.",
    regime: "step",
    hasRole: false,
    closable: false,
  },
};

/** Pistes dont une entrée peut être fermée explicitement par un `to`. */
export const CLOSABLE_TRACK_KEYS: readonly TrackKey[] = TRACK_KEYS.filter(
  (k) => TRACK_META[k].closable,
);

export function isClosable(key: TrackKey): boolean {
  return TRACK_META[key].closable;
}

/** Pistes admettant plusieurs valeurs actives simultanément. */
export const COOCCURRENT_TRACK_KEYS: readonly TrackKey[] = TRACK_KEYS.filter(
  (k) => TRACK_META[k].regime === "cooccurrent",
);

export function isCooccurrent(key: TrackKey): boolean {
  return TRACK_META[key].regime === "cooccurrent";
}

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
  wikidata_id: string; // QID — clé primaire
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
  wikidata_id: string; // QID — clé primaire
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

/**
 * Dimension pouvant être rendue en hulls sur la carte.
 * L'utilisateur en choisit UNE à la fois (sélecteur flottant) — l'empilement de
 * plusieurs dimensions simultanées était illisible.
 */
export type HullKind = "polity" | "culture" | "religion" | "language";

export const HULL_KINDS: readonly HullKind[] = [
  "polity",
  "culture",
  "religion",
  "language",
] as const;

// Polygone d'une entité à une année donnée — retourné par GET /api/hulls
export type HullFeature = {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][];
  };
  properties: {
    id: string; // wikidata_id de l'entité
    name: string;
    kind: HullKind;
    site_count: number;

    // Couleurs dérivées (voir hull-color.ts) — jamais stockées en base.
    color: string;
    stroke: string;

    // Famille de l'entité (religion/langue). Null pour polity/culture.
    family_qid: string | null;
    family_label: string | null;

    // Rôle le plus dominant parmi les sites qui composent ce hull.
    // Null sur les pistes step (le rôle n'y a pas de sens).
    top_role: RoleQualifier | null;
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
