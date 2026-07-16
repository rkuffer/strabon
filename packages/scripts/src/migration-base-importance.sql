-- =============================================================================
-- migration-base-importance.sql
-- -----------------------------------------------------------------------------
-- Two coupled changes to the importance model:
--
--   1. STATIC SOCLE — base_importance becomes a GENERATED STORED column derived
--      from sitelinks_count (+ an EN-Wikipedia-article bonus). sitelinks is the
--      best no-LLM proxy of notoriety and is filled by tiling; the column now
--      recomputes itself and can never drift from its inputs. Population is
--      DELIBERATELY excluded from the socle (sparse on ancient sites, over-values
--      modern megalopolises, and already correlates with sitelinks) — it lives
--      only in the dynamic layer where it is year-weighted.
--
--   2. DYNAMIC LAYER — compute_importance() gains a small, explicit
--      timeline-presence bonus (+10). During the test phase we extract
--      low-importance sites at random, so "has a timeline" must only NUDGE, never
--      dominate raw notoriety.
--
-- computed_importance (in querySites) = compute_importance(year, tl) + base_importance
--   → dynamic layer capped at 100, static socle capped at 100 ⇒ range 0..200.
--
-- base_importance is GENERATED: it can no longer be written explicitly. The
-- application upsert (packages/db/src/sites.ts) and the legacy migrate.ts have
-- been updated to stop inserting it.
--
-- Idempotent-ish: safe to re-run (drops/recreates the dependent view, index and
-- column). DROP COLUMN discards the old default-50 values, which were noise on
-- tiled sites anyway.
-- =============================================================================

BEGIN;

-- The debug view selects base_importance, so it must be dropped before the
-- column can be dropped, then recreated identically afterwards.
DROP VIEW IF EXISTS site_current_state;

-- Index on the column disappears with the column, but drop it explicitly for
-- clarity / re-runnability.
DROP INDEX IF EXISTS idx_sites_importance;

-- Remove the old plain column (INTEGER DEFAULT 50, hand-written by the retired
-- migrate.ts). Its values were undifferentiated (50) on the ~2M tiled sites.
ALTER TABLE sites DROP COLUMN IF EXISTS base_importance;

-- Re-add as a GENERATED STORED column.
--   core   = 20 * log10(sitelinks + 1)          [coefficient 20 confirmed]
--   bonus  = +8 if an EN Wikipedia article exists
--   gate   = 0 when there is neither a sitelink nor an article (bare points)
-- Examples: 0 sl no article → 0 ; 0 sl + article → 8 ; 3 sl → 20 ; 10 → 29 ;
--           100 → ~48 ; 1000 → ~68.
ALTER TABLE sites
  ADD COLUMN base_importance INTEGER
  GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(sitelinks_count, 0) = 0 AND wikipedia_page_en_url IS NULL
        THEN 0
      ELSE LEAST(
        100,
        (20 * LOG(COALESCE(sitelinks_count, 0) + 1))::INT
        + CASE WHEN wikipedia_page_en_url IS NOT NULL THEN 8 ELSE 0 END
      )
    END
  ) STORED;

CREATE INDEX idx_sites_importance ON sites(base_importance DESC);

-- Recreate the debug view exactly as before.
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

-- -----------------------------------------------------------------------------
-- Dynamic layer: add the timeline-presence bonus.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_importance(year_val INTEGER, tl JSONB)
RETURNS INTEGER AS $$
DECLARE
  site_type      TEXT;
  pop            BIGINT;
  type_score     INT;
  pop_score      INT;
  timeline_bonus INT;
BEGIN
  -- Resolve the site_type at the given year
  site_type := track_value_at(tl->'site_type', year_val) #>> '{}';

  type_score := CASE site_type
    WHEN 'capital'       THEN 100
    WHEN 'capital_city'  THEN 100
    WHEN 'metropolis'    THEN 90
    WHEN 'city'          THEN 75
    WHEN 'religious_site' THEN 65
    WHEN 'fortress'      THEN 60
    WHEN 'port'          THEN 60
    WHEN 'town'          THEN 50
    WHEN 'colony'        THEN 45
    WHEN 'administrative' THEN 40
    WHEN 'village'       THEN 30
    WHEN 'settlement'    THEN 20
    WHEN 'ruins'         THEN 35
    WHEN 'campsite'      THEN 10
    WHEN 'abandoned'     THEN 15
    ELSE 20
  END;

  -- Population at the given year
  SELECT (track_value_at(tl->'population', year_val) #>> '{}')::BIGINT INTO pop;

  pop_score := CASE
    WHEN pop IS NOT NULL AND pop > 0
    THEN LEAST(30, (LOG(pop) * 8)::INT)
    ELSE 0
  END;

  -- Light timeline-presence bonus: at comparable notoriety, steer the user's
  -- click toward a site that has content to show. Kept small so that randomly
  -- extracted low-importance sites do not float above genuinely notable ones.
  -- L0 sites (no timeline) get tl IS NULL ⇒ no bonus and type_score falls back
  -- to 20, so an extracted village (30 + 10) still outranks a bare point (20).
  timeline_bonus := CASE WHEN tl IS NOT NULL THEN 10 ELSE 0 END;

  RETURN LEAST(
    100,
    COALESCE(type_score, 20) + COALESCE(pop_score, 0) + timeline_bonus
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;
