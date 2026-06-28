import { getSql } from "./client.js";
import type { HullFeature } from "@strabon/shared";

// Distance maximale en degrés entre deux sites d'un même cluster.
// ~8° ≈ 890km — sépare le Levant de la péninsule ibérique pour les Phéniciens,
// tout en gardant ensemble des sites distants de quelques centaines de km.
const CLUSTER_EPS_DEG = 8;

// Nombre minimum de sites pour former un cluster DBSCAN.
// À 1, chaque site isolé forme son propre cluster (pas de sites orphelins).
const CLUSTER_MIN_POINTS = 1;

/**
 * Calcule les enveloppes concaves des polities à une année donnée.
 * - Clustering DBSCAN pour séparer les groupes géographiquement distants
 * - Intersection avec les terres émergées (ne_land) pour exclure les surfaces maritimes
 * - Exclut les sites en hiatus d'occupation (site_occupied_at)
 */
export async function queryPolityHulls(year: number): Promise<HullFeature[]> {
  const sql = getSql();

  const rows = await sql`
    WITH active_sites AS (
      SELECT
        s.location,
        (track_value_at(s.timeline->'polity', ${year})->>'wikidata') AS polity_wikidata,
        (track_value_at(s.timeline->'polity', ${year})->>'name')     AS polity_name
      FROM sites s
      WHERE s.location IS NOT NULL
        AND s.timeline->'polity' IS NOT NULL
        AND (s.inception_year IS NULL OR s.inception_year <= ${year})
        AND (s.dissolution_year IS NULL OR s.dissolution_year >= ${year})
        -- Exclut les sites en hiatus d'occupation à cette année
        AND site_occupied_at(s.timeline, ${year})
    ),
    -- Clustering DBSCAN par polity : chaque groupe géographiquement cohérent
    -- reçoit un cluster_id distinct
    clustered AS (
      SELECT
        polity_wikidata,
        polity_name,
        location,
        ST_ClusterDBSCAN(location, ${CLUSTER_EPS_DEG}, ${CLUSTER_MIN_POINTS})
          OVER (PARTITION BY polity_wikidata) AS cluster_id
      FROM active_sites
      WHERE polity_wikidata IS NOT NULL
        AND polity_wikidata NOT LIKE 'local_%'
    ),
    collected AS (
      SELECT
        polity_wikidata                          AS id,
        polity_name                              AS name,
        cluster_id,
        COUNT(*)                                 AS site_count,
        ST_Collect(location)                     AS geom_collect
      FROM clustered
      WHERE cluster_id IS NOT NULL
      GROUP BY polity_wikidata, polity_name, cluster_id
      HAVING COUNT(*) >= 2
    ),
    hulls AS (
      SELECT
        id, name, site_count, cluster_id,
        ST_Buffer(
          CASE
            WHEN site_count >= 5 THEN ST_ConcaveHull(geom_collect, 0.75)
            ELSE                      ST_ConvexHull(geom_collect)
          END,
          0.08
        ) AS hull
      FROM collected
    ),
    -- Union des terres émergées en un seul polygone pour l'intersection
    land AS (
      SELECT ST_Union(geom) AS geom FROM ne_land
    ),
    -- Clipper les hulls aux terres émergées
    clipped AS (
      SELECT
        h.id, h.name, h.site_count, h.cluster_id,
        ST_Intersection(h.hull, l.geom) AS hull
      FROM hulls h, land l
      WHERE ST_Intersects(h.hull, l.geom)
    )
    SELECT
      c.id,
      c.name,
      c.site_count,
      c.cluster_id,
      COALESCE(p.color, '#c9a84c') AS color,
      ST_AsGeoJSON(c.hull)::JSONB  AS geometry
    FROM clipped c
    LEFT JOIN polities p ON p.wikidata_id = c.id
    WHERE c.hull IS NOT NULL
      AND NOT ST_IsEmpty(c.hull)
  `;

  return rows.map((r: any) => ({
    type: "Feature",
    geometry: r.geometry,
    properties: {
      id: r.id,
      name: r.name,
      color: r.color,
      kind: "polity",
      site_count: Number(r.site_count),
    },
  })) as HullFeature[];
}

/**
 * Calcule les enveloppes concaves des cultures à une année donnée.
 * Même logique : clustering DBSCAN + intersection terres émergées + exclusion hiatus.
 */
export async function queryCultureHulls(year: number): Promise<HullFeature[]> {
  const sql = getSql();

  const rows = await sql`
    WITH active_sites AS (
      SELECT
        s.location,
        (track_value_at(s.timeline->'culture', ${year})->>'wikidata') AS culture_wikidata,
        (track_value_at(s.timeline->'culture', ${year})->>'name')     AS culture_name
      FROM sites s
      WHERE s.location IS NOT NULL
        AND s.timeline->'culture' IS NOT NULL
        AND (s.inception_year IS NULL OR s.inception_year <= ${year})
        AND (s.dissolution_year IS NULL OR s.dissolution_year >= ${year})
        -- Exclut les sites en hiatus d'occupation à cette année
        AND site_occupied_at(s.timeline, ${year})
    ),
    clustered AS (
      SELECT
        culture_wikidata,
        culture_name,
        location,
        ST_ClusterDBSCAN(location, ${CLUSTER_EPS_DEG}, ${CLUSTER_MIN_POINTS})
          OVER (PARTITION BY culture_wikidata) AS cluster_id
      FROM active_sites
      WHERE culture_wikidata IS NOT NULL
        AND culture_wikidata NOT LIKE 'local_%'
    ),
    collected AS (
      SELECT
        culture_wikidata                         AS id,
        culture_name                             AS name,
        cluster_id,
        COUNT(*)                                 AS site_count,
        ST_Collect(location)                     AS geom_collect
      FROM clustered
      WHERE cluster_id IS NOT NULL
      GROUP BY culture_wikidata, culture_name, cluster_id
      HAVING COUNT(*) >= 2
    ),
    hulls AS (
      SELECT
        id, name, site_count, cluster_id,
        ST_Buffer(
          CASE
            WHEN site_count >= 5 THEN ST_ConcaveHull(geom_collect, 0.75)
            ELSE                      ST_ConvexHull(geom_collect)
          END,
          0.08
        ) AS hull
      FROM collected
    ),
    land AS (
      SELECT ST_Union(geom) AS geom FROM ne_land
    ),
    clipped AS (
      SELECT
        h.id, h.name, h.site_count, h.cluster_id,
        ST_Intersection(h.hull, l.geom) AS hull
      FROM hulls h, land l
      WHERE ST_Intersects(h.hull, l.geom)
    )
    SELECT
      c.id,
      c.name,
      c.site_count,
      c.cluster_id,
      COALESCE(cu.color, '#7eb8a0') AS color,
      ST_AsGeoJSON(c.hull)::JSONB   AS geometry
    FROM clipped c
    LEFT JOIN cultures cu ON cu.wikidata_id = c.id
    WHERE c.hull IS NOT NULL
      AND NOT ST_IsEmpty(c.hull)
  `;

  return rows.map((r: any) => ({
    type: "Feature",
    geometry: r.geometry,
    properties: {
      id: r.id,
      name: r.name,
      color: r.color,
      kind: "culture",
      site_count: Number(r.site_count),
    },
  })) as HullFeature[];
}
