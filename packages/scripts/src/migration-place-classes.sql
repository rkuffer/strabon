-- packages/scripts/src/migration-place-classes.sql
-- =============================================================================
-- Migration: place_classes — curated Wikidata class whitelist for tiling.
-- Run once on existing DB, then integrate into schema.sql for reproducibility.
-- (NOTE: same debt as tiles/prompt_versions/etc. — see "tables absent from
-- schema.sql" in project notes. Applying this migration adds a 7th.)
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════════
-- place_classes — la liste blanche des classes Wikidata (P31) considérées comme
-- des "sites" au sens de l'atlas (lieux habités + sites archéologiques retenus).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Remplace le filtre en dur PLACE_CLASSES de tile-processor.ts (6 racines +
-- P279* calculé à la volée par Wikidata à chaque tuile). Deux problèmes que
-- cette table corrige :
--   1. Recall : "commune of France" (Q484170, 46184 instances) ne descend
--      d'AUCUNE des 6 racines historiques via P279* — tout un pan de la maille
--      communale française (et ses équivalents ailleurs) était invisible.
--   2. Nature du filtre : "archaeological site" (Q839954) n'est pas une
--      hiérarchie propre — c'est un sac plat de ~585 classes hétérogènes
--      (mégalithes funéraires, temples isolés, sites de production, termes de
--      méthodologie archéologique...). Une closure P279* dessus aspire du bruit
--      qui n'est pas un lieu habité. Pour cette racine on ne garde donc PAS la
--      closure entière mais une liste positive de types d'habitat.
--
-- Construction (voir build-place-classes.ts pour le détail reproductible) :
--   - closure P279* de "human settlement" (Q486972), MOINS les sous-arbres
--     parasites (camp, monastery, dwelling place, neighborhood, quarter, +
--     quelques items isolés)
--   - closure P279* de "municipality" (Q15284) entière (mesurée propre)
--   - liste POSITIVE (pas la closure) de "archaeological site" (Q839954) :
--     uniquement les types d'habitat (settlement/city/village/town/oppidum/
--     polis/burh/castro/...) + les catégories génériques par période
--     (Paleolithic/Stone Age/prehistoric/medieval/multi-period site) qu'on
--     garde même si elles englobent aussi des tombes/sanctuaires (décision
--     Rodolphe 15/07/2026 : mieux vaut un peu de bruit que rater les rares
--     traces d'habitat préhistorique).
--
-- DOCTRINE (Rodolphe, 15/07/2026) : on exclut agressivement, pas grave de
-- rater des parasites tant qu'on ne perd pas de vrais habitats — le projet a
-- déjà 2M+ sites, la contrainte n'est plus le volume mais la curation.

CREATE TABLE IF NOT EXISTS place_classes (
  qid         TEXT PRIMARY KEY,      -- QID Wikidata de la classe (ex. Q515)
  label       TEXT NOT NULL,         -- libellé anglais (cache, pour lisibilité humaine)
  root_qid    TEXT NOT NULL,         -- racine d'inclusion d'origine (Q486972 | Q15284 | Q839954)
  source      TEXT NOT NULL DEFAULT 'sparql-closure',  -- comment cette ligne a été obtenue
  built_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_place_classes_root
  ON place_classes(root_qid);
