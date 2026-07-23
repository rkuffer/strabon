-- =============================================================================
-- migration-site-attributions.sql
-- -----------------------------------------------------------------------------
-- SITE_ATTRIBUTIONS — rattachement site ↔ entité, INDÉPENDANT de l'extraction.
--
-- Pourquoi cette table existe
-- ---------------------------
-- Jusqu'ici, un site ne pouvait rejoindre un hull qu'en passant par l'extraction
-- L2 (LLM, coûteuse) : queryHulls lit exclusivement `timeline`. Mesure faite sur
-- le référentiel culture (juillet 2026) : Wikidata attribue déjà, via P2596, une
-- culture à 611 sites qui sont dans notre périmètre — dont 597 SONT DÉJÀ dans
-- notre table `sites` — mais seulement 7 d'entre eux ont une timeline. Autrement
-- dit ~590 rattachements sourcés, gratuits, restaient inexploitables faute d'une
-- étape LLM dont ils n'ont aucun besoin.
--
-- Cette table découple les deux : une attribution est un fait sourcé rattachant
-- un site à une entité, que le site ait été extrait ou non.
--
-- Ce qu'elle n'est PAS
-- --------------------
-- Ce n'est pas une timeline au rabais. Elle ne porte ni régime (step /
-- co-occurrent), ni rôle, ni séquence : juste « ce site relève de cette entité,
-- selon cette source ». Les nuances chronologiques fines restent le domaine de
-- `timeline`, produite par extraction et sourcée autrement.
--
-- Provenance : le champ `source` est ce qui interdit de confondre ce que dit
-- Wikidata avec ce qu'affirme le modèle — même principe que `bounds_source` sur
-- wikidata_entities. Une divergence entre les deux n'est pas un bug à masquer :
-- c'est un signal de curation (cas mesuré : le LLM attribue « Gauls » à 36 sites
-- là où Wikidata n'en soutient que 6, l'ethnonyme se substituant à la culture
-- archéologique).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS site_attributions (
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- Piste concernée. 'culture' aujourd'hui ; polity/religion/language plus tard
  -- si d'autres propriétés Wikidata s'avèrent aussi bien renseignées.
  kind         TEXT NOT NULL CHECK (kind IN ('polity', 'culture', 'religion', 'language')),

  -- Entité rattachée (QID). Pas de FK vers wikidata_entities : une attribution
  -- peut précéder l'entrée de l'entité au référentiel, et on ne veut pas perdre
  -- le fait sourcé en attendant. Le rendu, lui, exige l'entité (cf. queryHulls).
  entity_qid   TEXT NOT NULL,

  -- Provenance. 'wikidata-p2596' = propriété "culture" de Wikidata.
  source       TEXT NOT NULL CHECK (source IN ('wikidata-p2596', 'human')),

  -- Validité temporelle. P2596 ne date RIEN : Wikidata dit qu'un site relève
  -- d'une culture, jamais pendant quelles années. On recopie donc les bornes de
  -- l'entité au moment de l'ingestion — un site relève d'une culture pendant que
  -- cette culture existe. NULL = non borné : l'attribution est alors rendue à
  -- toute époque, ce qui est permissif à dessein (masquer silencieusement serait
  -- pire), mais le script d'ingestion compte ces cas pour qu'ils soient traités.
  from_year    INTEGER,
  to_year      INTEGER,

  -- Revue humaine : réservé aux corrections manuelles ultérieures.
  confirmed    BOOLEAN NOT NULL DEFAULT false,
  note         TEXT,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- `source` fait partie de la clé : si Wikidata ET un humain attribuent la même
  -- entité au même site, ce sont deux faits distincts, pas un doublon à écraser.
  PRIMARY KEY (site_id, kind, entity_qid, source)
);

-- Accès principal des hulls : toutes les attributions d'une entité pour un kind.
CREATE INDEX IF NOT EXISTS idx_site_attributions_entity
  ON site_attributions(kind, entity_qid);

-- Accès par site (fiche site, futures vues admin).
CREATE INDEX IF NOT EXISTS idx_site_attributions_site
  ON site_attributions(site_id);

COMMIT;
