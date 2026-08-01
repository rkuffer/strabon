-- =============================================================================
-- migration-polity-subordinate.sql
-- -----------------------------------------------------------------------------
-- Rang statique souverain/subordonné pour les entités polity (chantier
-- « déclutter micro-polities »). Modèle INVERSÉ : défaut = souverain, on ne
-- marque QUE l'exception subordonnée — miroir de l'inversion, trivial à lire
-- dans la requête hull (WHERE NOT subordinate).
--
-- Le rang est STATIQUE (un comté est toujours de rang subordonné) ; seul le lien
-- de suzeraineté serait temporel, et on ne le modélise pas. La colonne se peuple
-- en deux temps : (1) flag-polity-tiers.ts --apply pose true sur les titres de
-- rang statiques SÛRS ; (2) arbitrage manuel des cas AMBIGUS via /admin/entities.
--
-- Idempotent.
-- =============================================================================

ALTER TABLE wikidata_entities
  ADD COLUMN IF NOT EXISTS subordinate BOOLEAN NOT NULL DEFAULT false;

-- Index partiel : la requête hull filtrera sur la MINORITÉ subordonnée.
CREATE INDEX IF NOT EXISTS idx_wikidata_entities_subordinate
  ON wikidata_entities (subordinate) WHERE subordinate;