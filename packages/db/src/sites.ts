import { getSql } from "./client.js";
import type { SiteState, HullFeature } from "@strabon/shared";
import { MAX_MARKERS } from "@strabon/shared";
import type { SiteSearchResult } from "@strabon/shared";

export type SiteFilter = "timeline_only" | "all" | "no_timeline";

export type SitesQueryParams = {
  year: number;
  zoom: number;
  threshold: number;
  filter?: SiteFilter;
  bboxMinLon: number;
  bboxMinLat: number;
  bboxMaxLon: number;
  bboxMaxLat: number;
};

/**
 * Récupère les sites visibles dans un bounding box à une année donnée,
 * filtrés par score d'importance selon le zoom.
 * Retourne l'état courant (site_type, polity, culture) déjà résolu.
 * Les sites en hiatus d'occupation (site_occupied_at) sont exclus.
 */
export async function querySites(
  params: SitesQueryParams,
): Promise<SiteState[]> {
  const sql = getSql();
  const { year, threshold, bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat } =
    params;

  const rows = await sql`
    SELECT
      s.id,
      s.title_en                                            AS title,
      ST_Y(s.location)                                      AS lat,
      ST_X(s.location)                                      AS lon,
      s.base_importance,
      -- Score dynamique selon l'année
      COALESCE(compute_importance(${year}, s.timeline), 0) +
        s.base_importance                                   AS computed_importance,
      -- site_type résolu à l'année courante
      COALESCE(
        track_value_at(s.timeline->'site_type', ${year}) #>> '{}',
        s.site_type,
        'settlement'
      )                                                     AS site_type,
      -- Polity résolue
      track_value_at(s.timeline->'polity', ${year})        AS polity,
      -- Culture résolue
      track_value_at(s.timeline->'culture', ${year})       AS culture
    FROM sites s
    WHERE s.location IS NOT NULL
      -- Filtre temporel
      AND (s.inception_year IS NULL OR s.inception_year <= ${year})
      AND (s.dissolution_year IS NULL OR s.dissolution_year >= ${year})
      -- Exclut les sites en hiatus d'occupation à cette année
      AND site_occupied_at(s.timeline, ${year})
      -- Filtre géographique
      AND ST_Within(
        s.location,
        ST_MakeEnvelope(${bboxMinLon}, ${bboxMinLat}, ${bboxMaxLon}, ${bboxMaxLat}, 4326)
      )
      -- Filtre importance + zoom
      AND (
        COALESCE(compute_importance(${year}, s.timeline), 0) + s.base_importance
      ) >= ${threshold}
      -- Filtre timeline selon le mode demandé
      AND (
        (${params.filter ?? "timeline_only"} = 'timeline_only' AND s.timeline IS NOT NULL) OR
        (${params.filter ?? "timeline_only"} = 'no_timeline'   AND s.timeline IS NULL)    OR
        (${params.filter ?? "timeline_only"} = 'all')
      )
    ORDER BY computed_importance DESC
    LIMIT ${MAX_MARKERS}
  `;

  return rows as unknown as SiteState[];
}

/**
 * Récupère une entrée complète par ID (pour le panneau de détail).
 * NB : volontairement sans filtre d'occupation — un site en hiatus reste
 * consultable, le panneau timeline montre l'histoire complète (trou compris).
 */
export async function getSiteById(id: string) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      id, wikidata_id, title_en, wikipedia_page_en_url, source,
      ST_Y(location) AS lat, ST_X(location) AS lon,
      country, country_qid,
      inception_year, dissolution_year,
      site_type, base_importance,
      names, timeline, meta,
      last_updated, wikidata_enriched_at,
      timeline_extracted_at, timeline_extraction_model
    FROM sites
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Upsert d'une entrée site (utilisé par migrate.ts et enricher.ts).
 */
export async function upsertSite(site: {
  id: string;
  wikidata_id?: string;
  title_en: string;
  wikipedia_page_en_url?: string;
  source?: string;
  lat?: number;
  lon?: number;
  country?: string;
  country_qid?: string;
  inception_year?: number;
  dissolution_year?: number;
  site_type?: string;
  base_importance?: number;
  names?: Record<string, string>;
  timeline?: object;
  meta?: object;
  wikidata_enriched_at?: Date;
  timeline_extracted_at?: Date;
  timeline_extraction_model?: string;
}) {
  const sql = getSql();
  const location =
    site.lat != null && site.lon != null
      ? sql`ST_SetSRID(ST_MakePoint(${site.lon}, ${site.lat}), 4326)`
      : null;

  await sql`
    INSERT INTO sites (
      id, wikidata_id, title_en, wikipedia_page_en_url, source,
      location, country, country_qid,
      inception_year, dissolution_year,
      site_type, base_importance,
      names, timeline, meta,
      wikidata_enriched_at, timeline_extracted_at, timeline_extraction_model,
      last_updated
    ) VALUES (
      ${site.id},
      ${site.wikidata_id ?? null},
      ${site.title_en},
      ${site.wikipedia_page_en_url ?? null},
      ${site.source ?? null},
      ${location},
      ${site.country ?? null},
      ${site.country_qid ?? null},
      ${site.inception_year ?? null},
      ${site.dissolution_year ?? null},
      ${site.site_type ?? null},
      ${site.base_importance ?? 50},
      ${sql.json(site.names ?? {})},
      ${site.timeline ? sql.json(site.timeline) : null},
      ${sql.json(site.meta ?? {})},
      ${site.wikidata_enriched_at ?? null},
      ${site.timeline_extracted_at ?? null},
      ${site.timeline_extraction_model ?? null},
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      wikidata_id             = EXCLUDED.wikidata_id,
      title_en                = EXCLUDED.title_en,
      wikipedia_page_en_url   = EXCLUDED.wikipedia_page_en_url,
      source                  = EXCLUDED.source,
      location                = COALESCE(EXCLUDED.location, sites.location),
      country                 = COALESCE(EXCLUDED.country, sites.country),
      country_qid             = COALESCE(EXCLUDED.country_qid, sites.country_qid),
      inception_year          = COALESCE(EXCLUDED.inception_year, sites.inception_year),
      dissolution_year        = COALESCE(EXCLUDED.dissolution_year, sites.dissolution_year),
      site_type               = COALESCE(EXCLUDED.site_type, sites.site_type),
      base_importance         = COALESCE(EXCLUDED.base_importance, sites.base_importance),
      names                   = CASE
                                  WHEN EXCLUDED.names != '{}'::JSONB
                                  THEN EXCLUDED.names
                                  ELSE sites.names
                                END,
      timeline                = COALESCE(EXCLUDED.timeline, sites.timeline),
      meta                    = CASE
                                  WHEN EXCLUDED.meta != '{}'::JSONB
                                  THEN EXCLUDED.meta
                                  ELSE sites.meta
                                END,
      wikidata_enriched_at    = COALESCE(EXCLUDED.wikidata_enriched_at, sites.wikidata_enriched_at),
      timeline_extracted_at   = COALESCE(EXCLUDED.timeline_extracted_at, sites.timeline_extracted_at),
      timeline_extraction_model = COALESCE(EXCLUDED.timeline_extraction_model, sites.timeline_extraction_model),
      last_updated            = now()
  `;
}

/**
 * Recherche souple par nom sur tous les noms connus (search_text), insensible
 * aux accents. Combine word_similarity (flou, tolère les fautes) et LIKE
 * sous-chaîne, classe par score puis importance. Ignore année/bbox/zoom.
 */
export async function searchSites(
  q: string,
  limit = 8,
): Promise<SiteSearchResult[]> {
  const sql = getSql();
  const term = q.trim();
  if (term.length < 2) return [];

  // Échappe les métacaractères LIKE (\ % _) côté JS — le besoin de recentrage
  // ne doit pas transformer un "%" tapé par erreur en joker.
  const likeTerm = term.replace(/[\\%_]/g, (c) => "\\" + c);

  const rows = await sql`
    WITH q AS (
      SELECT
        f_unaccent(lower(${term}))     AS needle,
        f_unaccent(lower(${likeTerm})) AS like_needle
    )
    SELECT
      s.id,
      s.title_en        AS title,
      ST_Y(s.location)  AS lat,
      ST_X(s.location)  AS lon,
      s.country,
      GREATEST(
        word_similarity(q.needle, f_unaccent(lower(s.search_text))),
        CASE
          WHEN f_unaccent(lower(s.search_text)) LIKE q.like_needle || '%'        THEN 1.0
          WHEN f_unaccent(lower(s.search_text)) LIKE '%' || q.like_needle || '%' THEN 0.8
          ELSE 0
        END
      )::float AS score
    FROM sites s, q
    WHERE s.location IS NOT NULL
      AND s.search_text IS NOT NULL
      AND (
            word_similarity(q.needle, f_unaccent(lower(s.search_text))) >= 0.3
         OR f_unaccent(lower(s.search_text)) LIKE '%' || q.like_needle || '%'
      )
    ORDER BY score DESC, s.base_importance DESC
    LIMIT ${limit}
  `;
  return rows as unknown as SiteSearchResult[];
}
