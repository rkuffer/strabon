-- =============================================================================
-- migration-sovereign-entries.sql
-- -----------------------------------------------------------------------------
-- track_sovereign_entry() — lecture de la piste polity en SAUTANT les entités
-- subordonnées (chantier « déclutter micro-polities »).
--
-- POURQUOI une fonction séparée plutôt qu'un filtre dans queryHulls
-- ----------------------------------------------------------------
-- La piste polity est un STEP track : track_active_entries() renvoie UNE entrée,
-- celle au `from` le plus récent <= année. Donc sur Langweiler, en 1380, elle
-- renvoie « County of Sponheim » (from 1363) — PAS le Saint-Empire, même si
-- celui-ci n'a pas de `to`. Se contenter d'écarter les subordonnées APRÈS
-- l'appel ferait donc sortir le site de TOUT hull entre 1363 et 1794, alors
-- qu'il doit rester dans celui du Saint-Empire.
--
-- Il faut sauter les subordonnées AVANT la sélection du « plus récent », pour
-- retomber sur la dernière entrée SOUVERAINE. C'est ce que fait cette fonction.
--
-- SÉMANTIQUE DU `to` (prompt d'extraction, section « Regime 1b ») : sur polity,
-- « Do not close a polity merely because the next one begins » — un `to` ne
-- signale PAS le passage à l'entrée suivante, il signale un TROU véritable
-- (l'entité a disparu sans successeur nommable, ou le site est abandonné).
-- On le respecte donc tel quel : une souveraine explicitement fermée ne couvre
-- plus rien après son `to`, et le site sort de l'agrégat.
--
-- CHOIX CONSERVATEUR : si aucune entrée souveraine n'existe avant l'année
-- demandée (cas Munich, dont la piste démarre à « Duchy of Bavaria » puis
-- « Prince-Bishopric of Freising » sans que le Saint-Empire englobant soit
-- jamais posé — un défaut d'extraction), la fonction ne renvoie RIEN. Le site
-- est simplement absent de l'agrégat : on n'invente pas de rattachement.
--
-- Renvoie 0 ou 1 entrée, comme le régime step de track_active_entries().
-- =============================================================================

CREATE OR REPLACE FUNCTION track_sovereign_entry(
  track JSONB, year_val INTEGER
)
RETURNS SETOF JSONB AS $$
  SELECT latest.e
  FROM (
    SELECT e
    FROM jsonb_array_elements(COALESCE(track->'entries', '[]'::JSONB)) AS e
    LEFT JOIN wikidata_entities we
      ON we.qid = NULLIF(e->'value'->>'wikidata', '')
    WHERE (e->>'from')::INTEGER <= year_val
      -- Saute les subordonnées. IS DISTINCT FROM true laisse passer les entrées
      -- dont le QID est absent du référentiel (NULL) : on ne sait pas qu'elles
      -- sont subordonnées, donc on les traite comme souveraines — cohérent avec
      -- le défaut de la colonne.
      AND we.subordinate IS DISTINCT FROM true
    ORDER BY (e->>'from')::INTEGER DESC
    LIMIT 1
  ) AS latest
  WHERE latest.e->>'to' IS NULL
     OR year_val <= (latest.e->>'to')::INTEGER
$$ LANGUAGE SQL STABLE;