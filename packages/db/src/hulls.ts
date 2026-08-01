import { getSql } from "./client.js";
import {
  HULL_KINDS,
  ROLE_ORDER,
  TRACK_META,
  hullFillColor,
  hullStrokeColor,
  roleRank,
  type HullFeature,
  type HullKind,
  type RoleQualifier,
} from "@strabon/shared";

// Maximum distance in degrees between two sites of the same cluster.
// ~8deg ~= 890km — splits the Levant from Iberia for the Phoenicians, while
// keeping together sites a few hundred km apart.
const CLUSTER_EPS_DEG = 5;

// Minimum number of sites to form a DBSCAN cluster.
// At 1, an isolated site forms its own cluster (no orphan sites).
const CLUSTER_MIN_POINTS = 1;

// Below this, a group of sites does not describe an area — it describes a dot.
const MIN_SITES_PER_HULL = 3;

/**
 * Which timeline track backs each hull kind, and under which regime it must be
 * read. TRACK_META in @strabon/shared is the single source of truth for the
 * regime; we only assert here that a hull kind maps onto a real track.
 */
function trackFor(kind: HullKind): {
  track: string;
  regime: "step" | "cooccurrent";
} {
  const meta = TRACK_META[kind];
  if (!meta) throw new Error(`No track metadata for hull kind "${kind}"`);
  if (meta.regime === "occupation") {
    throw new Error(
      `Hull kind "${kind}" maps onto the occupation track — unsupported`,
    );
  }
  return { track: kind, regime: meta.regime };
}

/**
 * Roles kept when computing a hull, given the least dominant role the caller
 * accepts. Step tracks carry no role, and are never filtered by this.
 *
 * Default is "major", i.e. state + major: the hull of the dominant religion.
 * Opening it down to "minority" is a deliberate, and interesting, view — the
 * hull of medieval European Jewish communities is a legitimate thing to draw.
 */
function rolesUpTo(minRole: RoleQualifier): RoleQualifier[] {
  const limit = roleRank(minRole);
  return ROLE_ORDER.filter((r) => roleRank(r) <= limit);
}

export type HullQueryOptions = {
  /** Least dominant role contributing to a hull. Ignored on step tracks. */
  minRole?: RoleQualifier;
};

/**
 * Concave hulls of the entities present on one timeline track at a given year.
 *
 * - Reads the track through track_active_entries(), which handles both regimes:
 *   a step track yields ONE entity per site, a co-occurrent track yields N.
 *   EXCEPTION — the polity track goes through track_sovereign_entry(), which
 *   skips subordinate entities and falls back to the last sovereign entry, so a
 *   site pledged to a county still counts for the empire above it. A site with
 *   no sovereign entry at all before that year is simply absent (conservative:
 *   no invented attachment).
 * - DBSCAN clustering to split geographically disjoint groups of the same entity.
 * - Intersection with land (ne_land) to drop maritime surfaces.
 * - Excludes sites sitting in an occupation hiatus at that year.
 */
export async function queryHulls(
  kind: HullKind,
  year: number,
  opts: HullQueryOptions = {},
): Promise<HullFeature[]> {
  if (!HULL_KINDS.includes(kind)) {
    throw new Error(`Unknown hull kind: ${kind}`);
  }

  const sql = getSql();
  const { track, regime } = trackFor(kind);
  const roles = rolesUpTo(opts.minRole ?? "major");
  const isCooccurrent = regime === "cooccurrent";
  // Déclutter micro-polities : sur la piste polity, on lit la dernière entrée
  // SOUVERAINE, en sautant les subordonnées (comtés, seigneuries, villes libres
  // d'Empire…). Il faut les sauter AVANT la sélection du plus récent "from",
  // sinon un site sous County of Sponheim en 1380 sortirait de tout hull au lieu
  // de rester dans celui du Saint-Empire. Voir track_sovereign_entry().
  const isPolity = kind === "polity";

  const rows = await sql`
    WITH active_sites AS (
      SELECT
        s.location,
        NULLIF(entry->'value'->>'wikidata', '') AS entity_qid,
        entry->'value'->>'name'                 AS entity_name,
        role_rank(entry->>'role')               AS role_rk
      FROM sites s
      CROSS JOIN LATERAL ${
        isPolity
          ? sql`track_sovereign_entry(s.timeline -> ${track}, ${year}::INTEGER)`
          : sql`track_active_entries(s.timeline -> ${track}, ${year}::INTEGER, ${regime}::TEXT)`
      } AS entry
      WHERE s.location IS NOT NULL
        -- A site without an extracted timeline has nothing to contribute.
        -- Tiling indexes 2M+ sites at L0; only a few dozen carry a timeline.
        AND s.enrichment_level = 'extracted'
        -- jsonb_exists() uses the GIN index on timeline, unlike
        -- (timeline -> track) IS NOT NULL, which forces a full scan.
        AND jsonb_exists(s.timeline, ${track}::TEXT)
        AND (s.inception_year   IS NULL OR s.inception_year   <= ${year})
        AND (s.dissolution_year IS NULL OR s.dissolution_year >= ${year})
        -- Drop sites sitting in an occupation gap at this year
        AND site_occupied_at(s.timeline, ${year})
        -- Role filter, co-occurrent tracks only. A step track has no role, and
        -- role_rank(NULL) = 9, so it must not be filtered out here.
        AND (
          ${!isCooccurrent}
          OR entry->>'role' = ANY(${roles}::TEXT[])
        )
    ),
    -- DBSCAN per entity: each geographically coherent group gets its own id
    clustered AS (
      SELECT
        entity_qid,
        entity_name,
        role_rk,
        location,
        ST_ClusterDBSCAN(location, ${CLUSTER_EPS_DEG}, ${CLUSTER_MIN_POINTS})
          OVER (PARTITION BY entity_qid) AS cluster_id
      FROM active_sites
      WHERE entity_qid IS NOT NULL
        AND entity_qid NOT LIKE 'local_%'
    ),
    collected AS (
      SELECT
        entity_qid           AS id,
        entity_name          AS name,
        cluster_id,
        COUNT(*)             AS site_count,
        MIN(role_rk)            AS top_rank,
        ST_Collect(location) AS geom_collect
      FROM clustered
      WHERE cluster_id IS NOT NULL
      GROUP BY entity_qid, entity_name, cluster_id
      HAVING COUNT(*) >= ${MIN_SITES_PER_HULL}
    ),
    hulls AS (
      SELECT
        id, name, site_count, top_rank, cluster_id,
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
        h.id, h.name, h.site_count, h.top_rank, h.cluster_id,
        ST_Intersection(h.hull, l.geom) AS hull
      FROM hulls h, land l
      WHERE ST_Intersects(h.hull, l.geom)
    )
    SELECT
      c.id,
      c.name,
      c.site_count,
      c.top_rank,
      c.cluster_id,
      we.family_qid,
      we.family_label,
      ST_AsGeoJSON(c.hull)::JSONB AS geometry
    FROM clipped c
    LEFT JOIN wikidata_entities we ON we.qid = c.id
    WHERE c.hull IS NOT NULL
      AND NOT ST_IsEmpty(c.hull)
  `;

  return rows.map((r: any) => {
    const familyQid: string | null = r.family_qid ?? null;
    const colorInput = { kind, qid: r.id as string, familyQid };
    const topRank = Number(r.top_rank);

    return {
      type: "Feature",
      geometry: r.geometry,
      properties: {
        id: r.id,
        name: r.name,
        kind,
        site_count: Number(r.site_count),
        color: hullFillColor(colorInput),
        stroke: hullStrokeColor(colorInput),
        family_qid: familyQid,
        family_label: r.family_label ?? null,
        top_role:
          isCooccurrent && topRank < ROLE_ORDER.length
            ? (ROLE_ORDER[topRank] as RoleQualifier)
            : null,
      },
    };
  }) as HullFeature[];
}
