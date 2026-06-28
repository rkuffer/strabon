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
 * Cherche des entités d'autorité par nom.
 *
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
