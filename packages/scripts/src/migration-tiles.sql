-- =============================================================================
-- Migration: geographic tiling + sites enrichment gradation
-- Run once on existing DB, then integrate into schema.sql for reproducibility.
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Table des tuiles — file de travail du pavage mondial
-- ═══════════════════════════════════════════════════════════════════════════════
-- Chaque tuile = un carré 1°×1° aligné sur les degrés entiers.
-- Identifiée par son coin sud-ouest (lon_min, lat_min).
-- Le pavage SPARQL traite une tuile à la fois, écrit les sites trouvés
-- directement dans `sites` (niveau L0 = indexed), et marque la tuile done.

CREATE TABLE IF NOT EXISTS tiles (
  -- Coin sud-ouest du carré 1°. La tuile couvre [lon_min, lon_min+1) × [lat_min, lat_min+1).
  lon_min       INTEGER NOT NULL,
  lat_min       INTEGER NOT NULL,

  -- État dans le pavage.
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN (
                  'pending',      -- jamais traitée
                  'processing',   -- en cours (verrou concurrentiel)
                  'done'          -- indexée (voir site_count)
                )),

  -- Résultat du traitement.
  site_count    INTEGER,                -- nombre de sites trouvés (0 = tuile vide/océan)

  -- Audit & reprise.
  processed_at  TIMESTAMPTZ,            -- date de dernier traitement
  sparql_class_filter TEXT,             -- les classes utilisées (pour re-traitement si on élargit)

  PRIMARY KEY (lon_min, lat_min)
);

-- File de travail : sélection rapide des tuiles à traiter.
CREATE INDEX IF NOT EXISTS idx_tiles_status
  ON tiles(status);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Évolution de `sites` — gradation d'enrichissement + signaux de priorité
-- ═══════════════════════════════════════════════════════════════════════════════

-- Niveau de richesse du site dans le pipeline.
--   indexed   = L0, sorti du pavage (QID + coords + description Wikidata). Gratuit.
--   queued    = sélectionné pour extraction (dans la file de priorité).
--   extracted = L2, timeline complète (Extraction LLM effectuée).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS enrichment_level TEXT
  DEFAULT 'extracted'   -- les sites existants ont déjà une timeline → extracted
  CHECK (enrichment_level IN ('indexed', 'queued', 'extracted'));

-- Signaux de priorité — colonnes dédiées pour tri/filtrage efficace.
-- Peuplés à l'indexation (pavage), gratuits via Wikidata.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS sitelinks_count INTEGER;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS population BIGINT;

-- Index pour la file de priorité : "donne-moi les N sites indexed/queued les
-- plus importants" (tri par sitelinks_count DESC).
CREATE INDEX IF NOT EXISTS idx_sites_enrichment
  ON sites(enrichment_level);

CREATE INDEX IF NOT EXISTS idx_sites_sitelinks
  ON sites(sitelinks_count DESC NULLS LAST);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Pré-remplissage des tuiles terrestres via ne_land (Natural Earth 110m)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Génère toutes les tuiles 1° qui intersectent les terres émergées (avec un
-- buffer de 0.1° pour rattraper les côtes en basse résolution).
-- ~24 600 tuiles. Exécution en quelques secondes grâce à l'index GiST.

INSERT INTO tiles (lon_min, lat_min)
SELECT lon, lat
FROM generate_series(-180, 179) AS lon,
     generate_series(-90, 89) AS lat
WHERE EXISTS (
  SELECT 1 FROM ne_land
  WHERE ST_Intersects(
    ST_Expand(ST_MakeEnvelope(lon, lat, lon+1, lat+1, 4326), 0.1),
    geom
  )
)
ON CONFLICT DO NOTHING;
