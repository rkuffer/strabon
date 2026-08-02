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
-- DEUX BORNES, DE NATURES DIFFÉRENTES — ne pas les confondre :
--
--   1. `to` de l'ENTRÉE (JSON, écrit par le modèle). Prompt d'extraction,
--      section « Regime 1b » : « Do not close a polity merely because the next
--      one begins » — un `to` ne marque PAS le passage à l'entrée suivante, il
--      marque un TROU véritable (entité disparue sans successeur nommable, ou
--      site abandonné). On le respecte tel quel.
--
--   2. `dissolution` de l'ENTITÉ (wikidata_entities). Garde-fou contre la
--      REMONTÉE TROP LOIN : sauter une subordonnée de longue durée peut faire
--      retomber sur une souveraine morte depuis des siècles. Cas mesuré —
--      Q696417 : Roman Empire (100) → County of Sponheim (1037-1804,
--      subordonnée) → France (1806) ; en 1450 la remontée atterrit sur l'Empire
--      romain. Mesure sur 1200/1250/1450/1650 : 34 cas, tous des violations
--      massives et non ambiguës (Hittite Empire -1178, Old Babylonian -1750,
--      Carolingian 887, West Francia 987…).
--
-- ON ÉCARTE, ET ON S'ARRÊTE — jamais de second tour. Continuer à remonter ne
-- pourrait donner qu'une entrée ENCORE PLUS ANCIENNE, donc encore plus sûrement
-- dissoute et plus anachronique : ce serait mécaniquement pire. Si la dernière
-- souveraine ne convient pas, la fonction ne renvoie RIEN et le site sort de
-- l'agrégat pour cette année — même ligne conservatrice que le cas Munich (dont
-- la piste démarre à « Duchy of Bavaria » puis « Prince-Bishopric of Freising »
-- sans que le Saint-Empire englobant soit jamais posé) : on n'invente pas de
-- rattachement, l'absence est lisible.
--
-- NOTE — ce garde-fou ne corrige PAS les entrées « Roman Empire » portant un
-- `to: 1453` explicite (assimilation Empire romain / Empire byzantin par
-- l'extraction) : leur `to` étant postérieur, elles passent. Défaut
-- d'extraction, chantier distinct.
--
-- Renvoie 0 ou 1 entrée, comme le régime step de track_active_entries().
-- =============================================================================

CREATE OR REPLACE FUNCTION track_sovereign_entry(
  track JSONB, year_val INTEGER
)
RETURNS SETOF JSONB AS $$
  SELECT latest.e
  FROM (
    SELECT e, we.dissolution
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
  -- Les deux bornes, appliquées à la SEULE entrée retenue (pas de second tour).
  WHERE (latest.e->>'to' IS NULL
         OR year_val <= (latest.e->>'to')::INTEGER)
    AND (latest.dissolution IS NULL
         OR year_val <= latest.dissolution)
$$ LANGUAGE SQL STABLE;