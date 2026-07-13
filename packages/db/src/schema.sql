-- =============================================================================
-- Strabon — Schéma PostgreSQL + PostGIS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Table principale des sites ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sites (
  -- Identification
  id                      TEXT PRIMARY KEY,
  wikidata_id             TEXT UNIQUE,
  title_en                TEXT NOT NULL,
  wikipedia_page_en_url   TEXT,
  source                  TEXT,

  -- Géographie (PostGIS)
  location                GEOMETRY(Point, 4326),

  -- Pays actuel
  country                 TEXT,
  country_qid             TEXT,

  -- Temporel (colonnes indexées pour le slider)
  inception_year          INTEGER,
  dissolution_year        INTEGER,

  -- Classification Wikidata (héritage, peut être affiné par timeline)
  site_type               TEXT,

  -- Importance
  base_importance         INTEGER DEFAULT 50 CHECK (base_importance BETWEEN 0 AND 100),

  -- JSONB flexible
  names                   JSONB DEFAULT '{}',
  timeline                JSONB DEFAULT NULL,
  meta                    JSONB DEFAULT '{}',   -- description, native_label, cultures...

  -- Audit
  last_updated            TIMESTAMPTZ DEFAULT now(),
  wikidata_enriched_at    TIMESTAMPTZ,
  timeline_extracted_at   TIMESTAMPTZ,
  timeline_extraction_model TEXT
);

-- Index géospatial (requêtes bbox et distance)
CREATE INDEX IF NOT EXISTS idx_sites_location
  ON sites USING GIST(location);

-- Index temporel (slider de la carte)
CREATE INDEX IF NOT EXISTS idx_sites_temporal
  ON sites(inception_year, dissolution_year);

-- Index importance (filtrage zoom)
CREATE INDEX IF NOT EXISTS idx_sites_importance
  ON sites(base_importance DESC);

-- Index JSONB (requêtes sur la timeline)
CREATE INDEX IF NOT EXISTS idx_sites_timeline
  ON sites USING GIN(timeline);

CREATE INDEX IF NOT EXISTS idx_sites_names
  ON sites USING GIN(names);

-- ── Table des polities ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS polities (
  wikidata_id     TEXT PRIMARY KEY,   -- "Q2277" ou "local_canaan"
  name            TEXT NOT NULL,
  type            TEXT,               -- empire, kingdom, republic, city-state, caliphate, tribe, other
  color           TEXT,               -- hex ex. "#c9a84c"
  wikipedia_url   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Table des cultures ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cultures (
  wikidata_id     TEXT PRIMARY KEY,   -- "Q178794" ou "local_natufian"
  name            TEXT NOT NULL,
  type            TEXT,               -- archaeological_culture, civilization, period, religion
  color           TEXT,
  wikipedia_url   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Fonction SQL : résolution d'une piste à une année donnée ─────────────────
-- Équivalent de getValueAt() côté TypeScript, utilisée dans les requêtes SQL

CREATE OR REPLACE FUNCTION track_value_at(track JSONB, year_val INTEGER)
RETURNS JSONB AS $$
  SELECT e->'value'
  FROM jsonb_array_elements(track->'entries') AS e
  WHERE (e->>'from')::INTEGER <= year_val
  ORDER BY (e->>'from')::INTEGER DESC
  LIMIT 1
$$ LANGUAGE SQL IMMUTABLE;

-- ── Fonction SQL : occupation à une année donnée ─────────────────────────────
-- Miroir de isInOccupationGap() (inversé). FALSE uniquement si `year` tombe
-- dans un trou d'occupation explicite (site_type.to). TRUE partout ailleurs
-- ⇒ on laisse inception_year/dissolution_year borner le reste.
-- Rétrocompatible : pas de site_type, pas de `to`, ou year avant la 1ʳᵉ entrée ⇒ TRUE.

CREATE OR REPLACE FUNCTION site_occupied_at(tl JSONB, year_val INTEGER)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (
      SELECT CASE
               WHEN e->>'to' IS NULL                THEN TRUE
               WHEN year_val <= (e->>'to')::INTEGER THEN TRUE
               ELSE FALSE
             END
      FROM jsonb_array_elements(tl->'site_type'->'entries') AS e
      WHERE (e->>'from')::INTEGER <= year_val
      ORDER BY (e->>'from')::INTEGER DESC
      LIMIT 1
    ),
    TRUE
  )
$$ LANGUAGE SQL IMMUTABLE;

-- ── Fonction SQL : score d'importance dynamique ───────────────────────────────

CREATE OR REPLACE FUNCTION compute_importance(year_val INTEGER, tl JSONB)
RETURNS INTEGER AS $$
DECLARE
  site_type TEXT;
  pop       BIGINT;
  type_score INT;
  pop_score  INT;
BEGIN
  -- Résoudre le site_type à l'année donnée
  site_type := track_value_at(tl->'site_type', year_val) #>> '{}';

  type_score := CASE site_type
    WHEN 'capital'       THEN 100
    WHEN 'capital_city'  THEN 100
    WHEN 'metropolis'    THEN 90
    WHEN 'city'          THEN 75
    WHEN 'religious_site'THEN 65
    WHEN 'fortress'      THEN 60
    WHEN 'port'          THEN 60
    WHEN 'town'          THEN 50
    WHEN 'colony'        THEN 45
    WHEN 'administrative'THEN 40
    WHEN 'village'       THEN 30
    WHEN 'settlement'    THEN 20
    WHEN 'ruins'         THEN 35
    WHEN 'campsite'      THEN 10
    WHEN 'abandoned'     THEN 15
    ELSE 20
  END;

  -- Population à l'année donnée
  SELECT (track_value_at(tl->'population', year_val) #>> '{}')::BIGINT INTO pop;

  pop_score := CASE
    WHEN pop IS NOT NULL AND pop > 0
    THEN LEAST(30, (LOG(pop) * 8)::INT)
    ELSE 0
  END;

  RETURN LEAST(100, COALESCE(type_score, 20) + COALESCE(pop_score, 0));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── Vue : état courant d'un site (pratique pour debug) ───────────────────────

CREATE OR REPLACE VIEW site_current_state AS
SELECT
  id,
  title_en,
  ST_Y(location) AS lat,
  ST_X(location) AS lon,
  country,
  inception_year,
  dissolution_year,
  base_importance,
  site_type AS wikidata_site_type
FROM sites
WHERE location IS NOT NULL;


-- ── Recherche : extensions + unaccent immuable ───────────────────────────────
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() est STABLE (dépend du dictionnaire chargé), donc inutilisable dans
-- un index. On l'enveloppe en fixant le dictionnaire ⇒ déterministe ⇒ IMMUTABLE.
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ── Colonne agrégée des noms + maintenance par trigger ───────────────────────
ALTER TABLE sites ADD COLUMN IF NOT EXISTS search_text TEXT;

-- Agrège tous les noms connus : titre EN + names (toutes langues) +
-- meta.native_label + noms de la piste timeline.name. IMMUTABLE (n'utilise que
-- ses arguments), donc combinable avec le trigger.
CREATE OR REPLACE FUNCTION sites_build_search_text(
  p_title    TEXT,
  p_names    JSONB,
  p_meta     JSONB,
  p_timeline JSONB
) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT NULLIF(string_agg(DISTINCT term, ' ' ORDER BY term), '')
  FROM (
    SELECT p_title AS term
    UNION ALL
    SELECT v FROM jsonb_each_text(COALESCE(p_names, '{}'::jsonb)) AS kv(k, v)
    UNION ALL
    SELECT p_meta->>'native_label'
    UNION ALL
    SELECT e->'value'->>'text'
      FROM jsonb_array_elements(
             COALESCE(p_timeline->'name'->'entries', '[]'::jsonb)
           ) AS e
  ) AS terms(term)
  WHERE term IS NOT NULL AND term <> ''
$$;

CREATE OR REPLACE FUNCTION sites_search_text_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := sites_build_search_text(
    NEW.title_en, NEW.names, NEW.meta, NEW.timeline
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sites_search_text ON sites;
CREATE TRIGGER trg_sites_search_text
  BEFORE INSERT OR UPDATE OF title_en, names, meta, timeline ON sites
  FOR EACH ROW EXECUTE FUNCTION sites_search_text_trg();

-- Index trigramme sur la forme normalisée (sans accents, minuscules).
-- Sert à la fois word_similarity (<%) et LIKE '%…%'.
CREATE INDEX IF NOT EXISTS idx_sites_search_trgm
  ON sites USING GIN (f_unaccent(lower(search_text)) gin_trgm_ops);

-- Backfill for rows predating the trigger. The trigger keeps every insert and
-- update current, so this must never rescan the whole table: at a million sites
-- an unqualified UPDATE rewrites the entire relation on every schema run.
UPDATE sites
SET search_text = sites_build_search_text(title_en, names, meta, timeline)
WHERE search_text IS NULL;

-- =============================================================================
-- Référentiel d'autorité Wikidata — entités politiques et culturelles
-- Source : ingestion SPARQL depuis query.wikidata.org (packages/scripts/src/ingest-referential.ts).
-- Rôle : corpus de recherche fiable dans lequel on résout les QID.
-- NE PAS confondre avec les tables `polities`/`cultures` (usage applicatif).
-- (f_unaccent, unaccent et pg_trgm sont déjà définis dans le bloc recherche ci-dessus.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS wikidata_entities (
  -- Identité — le QID Wikidata est la clé d'autorité, stable et permanente.
  qid             TEXT PRIMARY KEY,         -- "Q70972"

  -- Nature granulaire, dérivée de la classe-racine SPARQL d'ingestion.
  -- Aujourd'hui : 'polity' | 'culture'. Demain : 'civilization' | 'period' | ...
  kind            TEXT NOT NULL,

  -- Libellé canonique (anglais — outil EN-only). Obligatoire : une entité sans
  -- label EN n'est pas ingérée.
  label_en        TEXT NOT NULL,

  -- Description courte Wikidata (EN), pour la désambiguïsation à la sélection.
  description_en  TEXT,

  -- Pays actuel associé (P17), QID. Opportuniste : souvent NULL pour les entités
  -- multi-pays (empires). Stocké tel quel, sans en faire une dépendance.
  country_qid     TEXT,

  -- Agrégat cherchable : label_en + label FR + tous les alias EN et FR.
  -- Rempli par le script d'ingestion. Cherché via f_unaccent(lower(...)).
  search_text     TEXT,

  -- Audit d'ingestion.
  ingested_at     TIMESTAMPTZ DEFAULT now(),
  source_class    TEXT                       -- QID de la classe-racine d'origine
);

-- Index trigramme pour la recherche souple (mêmes mécaniques que les sites :
-- word_similarity + LIKE, insensible aux accents).
CREATE INDEX IF NOT EXISTS idx_wikidata_entities_search_trgm
  ON wikidata_entities USING GIN (f_unaccent(lower(search_text)) gin_trgm_ops);

-- Filtrage fréquent par nature.
CREATE INDEX IF NOT EXISTS idx_wikidata_entities_kind
  ON wikidata_entities(kind);

-- =============================================================================
-- Table de travail : candidats de sites (pipeline Discovery → Resolution)
-- =============================================================================
-- Bac tampon entre les phases agentiques. Découplé de `sites` (production) :
--   Discovery  écrit ici (status='discovered')
--   Resolution lit ici, tranche l'identité/ancien-moderne, PROMEUT vers `sites`
--              (status='resolved' + produced_site_ids), ou écarte
--              (rejected/duplicate), ou demande l'humain (awaiting_human).
--   Extraction travaille ensuite sur `sites` (timeline IS NULL).
--
-- Un candidat produit 0, 1 ou N sites (Corinthe antique + moderne → 2).
-- Idempotence : Resolution ne traite que status='discovered' ; 'resolving' sert
-- de verrou contre les exécutions concurrentes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_candidates (
  -- Identité interne (un candidat peut ne PAS avoir de QID au stade Discovery).
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Provenance : l'intention en langage naturel qui a engendré ce candidat.
  discovery_intent      TEXT,

  -- Titre Wikipédia brut tel que découvert (ex. "Hacılar").
  raw_title             TEXT NOT NULL,

  -- URL canonique EN : DISCRIMINANT de dédoublonnage grossier (Discovery).
  -- Une même page Wikipédia = un seul candidat.
  wikipedia_page_en_url TEXT,

  -- QID Wikidata : souvent NULL à la découverte, établi par Resolution.
  wikidata_id           TEXT,

  -- Métadonnées brutes récupérées à la découverte.
  lat                   DOUBLE PRECISION,
  lon                   DOUBLE PRECISION,
  description           TEXT,

  -- État dans le pipeline. CHECK (et non ENUM) pour rester souple en phase d'itération.
  status                TEXT NOT NULL DEFAULT 'discovered'
                        CHECK (status IN (
                          'discovered',     -- sorti de Discovery, à traiter
                          'resolving',      -- Resolution en cours (verrou concurrentiel)
                          'awaiting_human',  -- escalade : question en attente
                          'resolved',       -- promu vers `sites` (voir produced_site_ids)
                          'rejected',       -- pas un site valide (ex. homonyme sans rapport)
                          'duplicate'       -- déjà présent en base
                        )),

  -- Escalade asynchrone vers l'humain (Resolution).
  human_question        TEXT,
  human_answer          TEXT,

  -- Sites engendrés par la résolution (0, 1 ou N QID). Audit + idempotence.
  produced_site_ids     TEXT[] NOT NULL DEFAULT '{}',

  -- Bornes temporelles transmises à Extraction pour cadrer la timeline
  -- (ex. Corinthe moderne : from_hint = 1858). Évite qu'une timeline déborde
  -- sur l'histoire de son prédécesseur. NULL = pas de contrainte.
  timeline_from_hint    INTEGER,
  timeline_to_hint      INTEGER,

  -- Raisonnement de l'agent (pourquoi fusion/séparation/rejet/doublon).
  resolution_notes      TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dédoublonnage grossier (Discovery) : recherche rapide par URL canonique.
CREATE INDEX IF NOT EXISTS idx_site_candidates_url
  ON site_candidates(wikipedia_page_en_url);

-- File de travail de Resolution : sélection des candidats à traiter par statut.
CREATE INDEX IF NOT EXISTS idx_site_candidates_status
  ON site_candidates(status);

-- Recherche par QID une fois résolu (dédoublonnage fiable, audit).
CREATE INDEX IF NOT EXISTS idx_site_candidates_wikidata
  ON site_candidates(wikidata_id);
-- =============================================================================
-- COUNTRIES
-- =============================================================================
-- Reference table for admin display, dropdown filters, and — crucially —
-- `lang_code`, used by buildWikipediaContext() to fetch the local-language
-- Wikipedia page of a site.

CREATE TABLE IF NOT EXISTS countries (
  qid         TEXT PRIMARY KEY,   -- "Q142"
  name_en     TEXT NOT NULL,
  name_local  TEXT,
  lang_code   TEXT                -- "fr" — drives local Wikipedia retrieval
);


-- =============================================================================
-- TILES — geographic discovery grid
-- =============================================================================
-- The discovery phase is deterministic: a SPARQL bounding-box query per tile,
-- filtered by place classes, populating `sites` at enrichment_level='indexed'.
-- Tiling subsumes name search: to target a site, process its enclosing tile —
-- you get the site plus its geographic neighbourhood, with no name ambiguity.
--
-- Primary key is the tile's south-west corner, in whole degrees (1x1 grid).

CREATE TABLE IF NOT EXISTS tiles (
  lon_min             INTEGER NOT NULL,
  lat_min             INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'done')),
  site_count          INTEGER,             -- sites found by the SPARQL query
  processed_at        TIMESTAMPTZ,
  sparql_class_filter TEXT,                -- class list used, for auditability
  PRIMARY KEY (lon_min, lat_min)
);

CREATE INDEX IF NOT EXISTS idx_tiles_status ON tiles(status);


-- =============================================================================
-- REFERENTIAL GAPS
-- =============================================================================
-- When extraction meets a religion / language / polity / culture that is not in
-- `wikidata_entities`, it signals the gap rather than silently dropping it — or,
-- worse, substituting a sibling or parent entity. The QID-stripping guards in
-- validate-timeline.ts also feed this table.
--
-- UNIQUE (kind, name): the same missing entity met on twenty sites is ONE gap,
-- accumulating site_ids.

CREATE TABLE IF NOT EXISTS referential_gaps (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            TEXT NOT NULL
                    CHECK (kind IN ('religion', 'language', 'polity', 'culture')),
  name            TEXT NOT NULL,           -- the TRUE missing name, never a substitute
  context         TEXT,                    -- what the model said about it
  proposed_qid    TEXT,                    -- LLM-proposed QID, UNVERIFIED
  site_ids        TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'resolved', 'rejected')),
  resolved_qid    TEXT,                    -- verified QID, after human review
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

CREATE INDEX IF NOT EXISTS idx_referential_gaps_kind   ON referential_gaps(kind);
CREATE INDEX IF NOT EXISTS idx_referential_gaps_status ON referential_gaps(status);


-- =============================================================================
-- RUN HISTORY — prompt_versions + site_extractions
-- =============================================================================
-- Git is the source of truth for the prompt; these tables are a LOG, like a
-- deployment log. What is hashed is the prompt TEMPLATE (with its {{markers}}
-- unsubstituted), not an instantiation — so the hash is idempotent across sites.
--
-- EVERY run is recorded, previews included: previews ARE the corpus. Agreement
-- between runs on the same site is a CURATION PRIORITY SIGNAL — it discriminates
-- STABLE from UNSTABLE, never TRUE from FALSE. It must not be confused with the
-- model's `confidence`, which is its view of the SOURCES. The interesting cell
-- is "high confidence + low agreement" = confident hallucination.

CREATE TABLE IF NOT EXISTS prompt_versions (
  hash          TEXT PRIMARY KEY,          -- hash of the TEMPLATE, not of an instance
  kind          TEXT NOT NULL,             -- 'extraction' | ...
  template      TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_count     INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_kind
  ON prompt_versions(kind, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS site_extractions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  timeline         JSONB NOT NULL,
  model            TEXT NOT NULL,
  prompt_hash      TEXT REFERENCES prompt_versions(hash),
  referential_hash TEXT,                   -- the referential injected into the prompt
  local_lang       TEXT,                   -- local Wikipedia language actually used
  qid_violations   INTEGER NOT NULL DEFAULT 0,
  rejected         BOOLEAN NOT NULL DEFAULT FALSE,
  rejection_reason TEXT,
  confirmed        BOOLEAN NOT NULL DEFAULT FALSE,  -- stamped by /confirm
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_extractions_site
  ON site_extractions(site_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_extractions_prompt
  ON site_extractions(prompt_hash);

CREATE INDEX IF NOT EXISTS idx_site_extractions_confirmed
  ON site_extractions(site_id) WHERE confirmed;


-- =============================================================================
-- NE_LAND — Natural Earth landmass (110m)
-- =============================================================================
-- Populated by an import script, not by this file. Declared here because the
-- hull queries depend on it: hulls are clipped to land so they do not spill
-- across the sea.

CREATE TABLE IF NOT EXISTS ne_land (
  id   SERIAL PRIMARY KEY,
  geom GEOMETRY(MultiPolygon, 4326)
);

CREATE INDEX IF NOT EXISTS ne_land_geom_idx ON ne_land USING GIST (geom);


-- =============================================================================
-- SITES — enrichment gradation (added after the tiling pipeline landed)
-- =============================================================================
-- Richness gradation: tiling indexes a site cheaply at L0; only a selected
-- priority subset is promoted to the expensive LLM extraction (L2). Noise stays
-- attenuated at L0 and is never paid for.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS enrichment_level TEXT DEFAULT 'extracted';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS sitelinks_count  INTEGER;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS population       BIGINT;

DO $$
BEGIN
  ALTER TABLE sites ADD CONSTRAINT sites_enrichment_level_check
    CHECK (enrichment_level IN ('indexed', 'queued', 'extracted', 'excluded'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Priority selection: Wikidata sitelinks count is a strong proxy for historical
-- importance, and is computable without an LLM.
CREATE INDEX IF NOT EXISTS idx_sites_enrichment ON sites(enrichment_level);
CREATE INDEX IF NOT EXISTS idx_sites_sitelinks  ON sites(sitelinks_count DESC NULLS LAST);


-- =============================================================================
-- WIKIDATA_ENTITIES — families
-- =============================================================================
-- A GROUPING, not a filiation: `family_qid` places an entity in its family
-- (Indo-European languages, Abrahamic religions). It is NOT parent_qid, which
-- would express descent and does not exist yet.
--
-- Families drive hull colour: the family gives the hue, the entity gives the
-- variant. See hull-color.ts — colour is DERIVED, never stored.

ALTER TABLE wikidata_entities ADD COLUMN IF NOT EXISTS family_qid   TEXT;
ALTER TABLE wikidata_entities ADD COLUMN IF NOT EXISTS family_label TEXT;

CREATE INDEX IF NOT EXISTS idx_wikidata_entities_family
  ON wikidata_entities(family_qid) WHERE family_qid IS NOT NULL;


-- =============================================================================
-- HULLS — reading a track at a given year, per regime
-- =============================================================================

-- Identity key of an entity. Mirrors entityKey() in timeline-utils.ts:
-- QID first, normalized name as fallback. An empty wikidata string is absent.
CREATE OR REPLACE FUNCTION entity_key(val JSONB)
RETURNS TEXT AS $$
  SELECT COALESCE(
    NULLIF(val->>'wikidata', ''),
    lower(trim(val->>'name'))
  )
$$ LANGUAGE SQL IMMUTABLE;

-- Rank of a role qualifier (0 = most dominant). Mirrors roleRank().
CREATE OR REPLACE FUNCTION role_rank(role TEXT)
RETURNS INTEGER AS $$
  SELECT CASE role
    WHEN 'state'    THEN 0
    WHEN 'major'    THEN 1
    WHEN 'minor'    THEN 2
    WHEN 'minority' THEN 3
    ELSE 9
  END
$$ LANGUAGE SQL IMMUTABLE;

-- All entries of a track active at a given year, per regime.
--
--   'step'        : ONE entry. A new entry implicitly closes the previous one
--                   (polity, culture, name, population).
--
--   'cooccurrent' : the latest entry of EACH entity, kept only if it has not
--                   been explicitly closed by a `to` (religion, language).
--                   On a co-occurrent track nothing closes an entry implicitly
--                   except a later entry of the SAME entity — which is a role
--                   change, absorbed for free by taking the latest per entity.
--                   This is the SQL mirror of buildLanes() in timeline-utils.ts.
--
-- Returns whole entries (value + role), not bare values like track_value_at().
CREATE OR REPLACE FUNCTION track_active_entries(
  track JSONB, year_val INTEGER, regime TEXT
)
RETURNS SETOF JSONB AS $$
  (
    SELECT e
    FROM jsonb_array_elements(COALESCE(track->'entries', '[]'::JSONB)) AS e
    WHERE regime = 'step'
      AND (e->>'from')::INTEGER <= year_val
    ORDER BY (e->>'from')::INTEGER DESC
    LIMIT 1
  )
  UNION ALL
  (
    SELECT latest.e
    FROM (
      SELECT DISTINCT ON (entity_key(e->'value')) e
      FROM jsonb_array_elements(COALESCE(track->'entries', '[]'::JSONB)) AS e
      WHERE regime = 'cooccurrent'
        AND (e->>'from')::INTEGER <= year_val
      ORDER BY entity_key(e->'value'), (e->>'from')::INTEGER DESC
    ) AS latest
    WHERE latest.e->>'to' IS NULL
       OR year_val <= (latest.e->>'to')::INTEGER
  )
$$ LANGUAGE SQL IMMUTABLE;