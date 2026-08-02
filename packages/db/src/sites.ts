import { getSql } from "./client.js";
import type {
  SiteState,
  HullFeature,
  SiteTimeline,
  JsonObject,
} from "@strabon/shared";
import { MAX_MARKERS, MIN_RESULTS } from "@strabon/shared";
import type { SiteSearchResult } from "@strabon/shared";

export type SiteFilter = "timeline_only" | "all" | "no_timeline";

export type SitesQueryParams = {
  year: number;
  zoom: number;
  threshold: number;
  // Seuil sur base_importance SEUL (notoriété réelle, sans bonus dynamique) —
  // gate dominant aux zooms larges pour éviter qu'un site mineur extrait ne
  // s'affiche au dézoom mondial via le seul bonus timeline (bug Rocamadour,
  // voir BASE_ZOOM_THRESHOLDS dans @strabon/shared). Optionnel pour ne pas
  // casser un appelant existant ; défaut 0 = aucun effet, comportement inchangé.
  baseThreshold?: number;
  // Plancher adaptatif : si le filtrage strict renvoie moins que ce nombre, on
  // rejoue en relâchant les seuils pour ne pas afficher une carte vide là où
  // des sites existent. 0 désactive le repli (comportement strict d'origine).
  minResults?: number;
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
  const {
    year,
    threshold,
    baseThreshold = 0,
    minResults = MIN_RESULTS,
    bboxMinLon,
    bboxMinLat,
    bboxMaxLon,
    bboxMaxLat,
  } = params;

  const filter = params.filter ?? "timeline_only";

  /**
   * Une seule requête, paramétrée par les seuils EFFECTIFS.
   *
   * `rankByBase` est dissocié de `effBaseThreshold` à dessein : lors du repli,
   * on relâche le FILTRAGE sans changer le CLASSEMENT. Sinon un repli au zoom
   * mondial se remettrait à trier sur le score combiné, et le bonus dynamique
   * ferait remonter un village extrait devant une métropole — exactement le
   * biais que le tri par notoriété corrige (cf. BASE_ZOOM_THRESHOLDS).
   */
  const run = (
    effThreshold: number,
    effBaseThreshold: number,
    rankByBase: boolean,
    limit: number,
  ) => sql`
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
      track_value_at(s.timeline->'culture', ${year})       AS culture,
      -- L0 (indexé, tiling seul) vs L2 (extrait) → rendu atténué côté carte
      (s.timeline IS NOT NULL)                              AS has_timeline
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
      -- Filtre importance + zoom (score combiné — reste franchissable via le
      -- bonus dynamique/timeline seul, voir la note sur BASE_ZOOM_THRESHOLDS)
      AND (
        COALESCE(compute_importance(${year}, s.timeline), 0) + s.base_importance
      ) >= ${effThreshold}
      -- Second gate : notoriété réelle SEULE, sans bonus dynamique. Dominant
      -- aux zooms larges (baseThreshold élevé), s'efface aux zooms serrés
      -- (baseThreshold→0). Empêche un site mineur extrait de s'afficher au
      -- dézoom mondial via le seul bonus timeline (cf. Rocamadour).
      AND s.base_importance >= ${effBaseThreshold}
      -- Filtre timeline selon le mode demandé
      AND (
        (${filter} = 'timeline_only' AND s.timeline IS NOT NULL) OR
        (${filter} = 'no_timeline'   AND s.timeline IS NULL)    OR
        (${filter} = 'all')
      )
    -- Tri : aux zooms larges, on classe par NOTORIÉTÉ RÉELLE d'abord. Sinon le
    -- LIMIT choisirait ses survivants au score combiné, donc dominés par le
    -- bonus dynamique (jusqu'à +100 pour un site extrait) : un village extrait
    -- passerait devant une métropole non extraite. Le filtre base_importance ne
    -- suffit pas à l'éviter — il décide QUI est éligible, pas qui survit au
    -- LIMIT. Aux zooms serrés le CASE devient constant et le tri retombe sur
    -- computed_importance, où le bonus « a du contenu » est légitime.
    ORDER BY
      (CASE WHEN ${rankByBase} THEN s.base_importance ELSE 0 END) DESC,
      computed_importance DESC
    LIMIT ${limit}
  `;

  const rankByBase = baseThreshold > 0;
  const rows = await run(threshold, baseThreshold, rankByBase, MAX_MARKERS);

  // Filtrage strict suffisant, ou repli désactivé : on s'arrête là. C'est le
  // chemin rapide, inchangé — les seuils élaguent toujours avant l'appel plpgsql.
  if (rows.length >= minResults || minResults <= 0) {
    return rows as unknown as SiteState[];
  }

  /**
   * REPLI. Les seuils sont calibrés mondialement mais s'appliquent localement :
   * une fenêtre pauvre peut ne rien laisser passer alors que des sites existent.
   * On rejoue sans les seuils de zoom, borné à `minResults`.
   *
   * On garde `base_importance > 0` : cette borne n'est pas un seuil de zoom mais
   * la porte anti-bruit de la colonne générée (ni sitelink, ni article = point
   * de coordonnées nu). La relâcher ferait remonter du bruit pur, ce qui n'est
   * pas le but — on veut les sites MODESTES, pas les non-sites.
   *
   * Le résultat est un SUR-ENSEMBLE du strict (mêmes filtres géo/temporels,
   * seuils plus bas), trié pareil : les sites déjà retenus restent en tête.
   */
  const relaxed = await run(0, 1, rankByBase, minResults);
  return relaxed as unknown as SiteState[];
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
      s.id, s.wikidata_id, s.title_en, s.wikipedia_page_en_url, s.source,
      ST_Y(s.location) AS lat, ST_X(s.location) AS lon,
      s.country, s.country_qid,
      s.inception_year, s.dissolution_year,
      s.site_type, s.base_importance,
      s.names, s.timeline, s.meta,
      s.last_updated, s.wikidata_enriched_at,
      s.timeline_extracted_at, s.timeline_extraction_model,
      -- Rang des entités polity citées par CE site. Le front en a besoin pour
      -- rendre la piste polity sur deux couloirs (souverain / subordonné) : la
      -- timeline stockée ne porte que des QID, le rang vit sur le référentiel.
      -- Restreint aux QID réellement présents dans la timeline du site (pas la
      -- liste globale des subordonnées, qui serait inutilement lourde).
      COALESCE((
        SELECT ARRAY_AGG(DISTINCT w.qid)
        FROM jsonb_array_elements(
               COALESCE(s.timeline->'polity'->'entries', '[]'::JSONB)
             ) AS e
        JOIN wikidata_entities w
          ON w.qid = NULLIF(e->'value'->>'wikidata', '')
        WHERE w.subordinate
      ), ARRAY[]::TEXT[]) AS subordinate_qids
    FROM sites s
    WHERE s.id = ${id}
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
  // base_importance est désormais une colonne GÉNÉRÉE (dérivée de
  // sitelinks_count + article EN) : elle ne peut plus être écrite explicitement.
  names?: Record<string, string>;
  timeline?: SiteTimeline;
  meta?: JsonObject;
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
      site_type,
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
