// packages/db/src/entities.ts
// =============================================================================
// Recherche dans le référentiel d'autorité Wikidata (`wikidata_entities`).
//
// Brique de résolution de QID : prend un nom, retourne des candidats réels
// (QID + label + description + pays) parmi lesquels le consommateur (LLM ou
// humain) tranche. Ne décide PAS — fournit le choix.
//
// Mécanique identique à searchSites : word_similarity (pg_trgm) + fallback LIKE,
// insensible aux accents via f_unaccent. Parti pris "rappel large" : seuil
// permissif et limite généreuse, car c'est le consommateur qui filtre ensuite.
// =============================================================================

import { getSql } from "./client.js";

export type EntityCandidate = {
  qid: string;
  kind: string;
  label_en: string;
  description_en: string | null;
  country_qid: string | null;
  score: number;
};

// Échappe les métacaractères LIKE (%, _, \) dans la saisie utilisateur,
// pour qu'ils soient traités littéralement et non comme des jokers.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * Fiche complète d'une entité du référentiel, pour la modale ouverte au clic sur
 * un segment de timeline.
 *
 * Renvoie null si le QID n'est PAS dans le référentiel — cas normal et non
 * exceptionnel : une timeline peut citer un QID jamais ingéré (entrée résolue à
 * la main, ou entité d'une nature non ingérée). L'appelant reste alors capable
 * d'offrir le lien Wikidata, qui ne dépend que du QID.
 *
 * `usage_count` compte les SITES qui citent ce QID sur l'une des quatre pistes
 * référentielles — c'est la même mesure que la colonne « usage » de
 * /admin/entities, utile pour situer l'entité (une entité citée 200 fois n'a pas
 * le même statut qu'un hapax).
 */
export type EntityDetail = {
  qid: string;
  kind: string;
  label_en: string;
  description_en: string | null;
  country_qid: string | null;
  family_qid: string | null;
  family_label: string | null;
  active: boolean;
  subordinate: boolean;
  inception: number | null;
  inception_precision: number | null;
  dissolution: number | null;
  dissolution_precision: number | null;
  bounds_source: string | null;
  bounds_confirmed: boolean;
  bounds_note: string | null;
  sitelinks_count: number | null;
  usage_count: number;
};

export async function getEntityDetail(
  qid: string,
): Promise<EntityDetail | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT
      w.qid, w.kind, w.label_en, w.description_en, w.country_qid,
      w.family_qid, w.family_label,
      w.active, w.subordinate,
      w.inception, w.inception_precision,
      w.dissolution, w.dissolution_precision,
      w.bounds_source, w.bounds_confirmed, w.bounds_note,
      w.sitelinks_count,
      COALESCE((
        SELECT COUNT(DISTINCT s.id)::int
        FROM sites s,
             LATERAL unnest(ARRAY['polity','culture','religion','language']) AS t(track),
             LATERAL jsonb_array_elements(
               COALESCE(s.timeline->t.track->'entries', '[]'::JSONB)
             ) AS e
        WHERE s.timeline IS NOT NULL
          AND e->'value'->>'wikidata' = w.qid
      ), 0) AS usage_count
    FROM wikidata_entities w
    WHERE w.qid = ${qid}
    LIMIT 1
  `;
  return (rows[0] as unknown as EntityDetail) ?? null;
}

/*
 * @param query  Nom recherché (ex. "Roman Republic"). Min. 2 caractères.
 * @param opts.kind   Filtre optionnel sur la nature ("polity" | "culture" | …).
 * @param opts.limit  Nombre max de candidats (défaut 8, plafond 25).
 * @returns Candidats triés par pertinence décroissante.
 */
export async function searchEntities(
  query: string,
  opts: { kind?: string | null; limit?: number } = {},
): Promise<EntityCandidate[]> {
  const sql = getSql();

  const needle = query.trim();
  if (needle.length < 2) return [];

  const limit = Math.min(opts.limit ?? 8, 25);
  const kind = opts.kind ?? null;
  const likePattern = `%${escapeLike(needle.toLowerCase())}%`;

  const rows = await sql`
    SELECT
      qid,
      kind,
      label_en,
      description_en,
      country_qid,
      word_similarity(
        f_unaccent(lower(${needle})),
        f_unaccent(lower(search_text))
      ) AS score
    FROM wikidata_entities
    WHERE
      ${kind ? sql`kind = ${kind} AND` : sql``}
      (
        word_similarity(
          f_unaccent(lower(${needle})),
          f_unaccent(lower(search_text))
        ) >= 0.3
        OR f_unaccent(lower(search_text)) LIKE ${likePattern}
      )
    ORDER BY score DESC, length(label_en) ASC
    LIMIT ${limit}
  `;

  return rows as unknown as EntityCandidate[];
}
