// packages/server/src/routes/admin/curation.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";

export const adminCurationRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/curation — list sites by priority, filterable
  app.get<{
    Querystring: {
      q?: string;
      level?: "indexed" | "queued" | "extracted" | "all";
      country?: string;
      page?: string;
    };
  }>("/admin/curation", async (req, reply) => {
    const sql = getSql();
    const { q, level = "indexed", country, page = "1" } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const conditions: string[] = [];
    const qEsc = q ? q.replace(/'/g, "''") : "";
    if (q)
      conditions.push(
        `(s.title_en ILIKE '%${qEsc}%' OR s.meta->>'wikidata_description' ILIKE '%${qEsc}%')`,
      );
    if (level && level !== "all")
      conditions.push(`s.enrichment_level = '${level}'`);
    if (country)
      conditions.push(`s.country_qid = '${country.replace(/'/g, "''")}'`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Avec une recherche texte : la correspondance exacte du titre d'abord,
    // puis les titres qui commencent par la requête, puis le reste (matches
    // sur la description ou en milieu de titre) — importance en tie-break.
    // Sans recherche : l'ordre habituel piloté par l'importance.
    const orderBy = q
      ? `CASE
           WHEN lower(s.title_en) = lower('${qEsc}') THEN 0
           WHEN s.title_en ILIKE '${qEsc}%' THEN 1
           ELSE 2
         END,
         s.base_importance DESC NULLS LAST, s.sitelinks_count DESC NULLS LAST, s.title_en`
      : `s.base_importance DESC NULLS LAST, s.sitelinks_count DESC NULLS LAST, s.title_en`;

    const [sites, totalRow, countries, levelCounts] = await Promise.all([
      sql.unsafe(`
        SELECT s.id, s.title_en,
               s.country_qid,
               c.name_en AS country_name,
               s.enrichment_level,
               s.base_importance,
               s.sitelinks_count,
               s.population,
               s.meta->>'wikidata_description' AS description,
               s.meta->>'wikidata_type' AS site_type,
               ST_Y(s.location) AS lat,
               ST_X(s.location) AS lon,
               s.timeline IS NOT NULL AS has_timeline
        FROM sites s
        LEFT JOIN countries c ON c.qid = s.country_qid
        ${where}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}
      `),
      sql.unsafe(`SELECT COUNT(*)::int AS count FROM sites s ${where}`),
      sql`SELECT c.qid, c.name_en FROM countries c ORDER BY c.name_en`,
      sql`SELECT enrichment_level, COUNT(*)::int AS count FROM sites GROUP BY enrichment_level ORDER BY enrichment_level`,
    ]);

    return reply.view("admin/curation/index", {
      title: "Curation — Admin",
      sites,
      total: totalRow[0].count,
      page: parseInt(page),
      pages: Math.ceil(totalRow[0].count / limit),
      q,
      level,
      country,
      countries,
      levelCounts,
      limit,
    });
  });

  // POST /admin/curation/queue — mark selected sites as 'queued'
  //
  // FIRST-PASS ONLY: promotes indexed→queued and nothing else. The guard is
  // deliberate — the bulk buttons on /admin/curation & /admin/attributions run
  // against lists of indexed sites, and this gate is what keeps them from ever
  // silently re-running an already-extracted site. Re-extraction goes through
  // /requeue below, never here.
  app.post<{
    Body: { site_ids: string[] };
  }>("/admin/curation/queue", async (req, reply) => {
    const sql = getSql();
    const ids: string[] = req.body?.site_ids ?? [];

    let updated = 0;
    if (ids.length > 0) {
      const result = await sql`
        UPDATE sites
        SET enrichment_level = 'queued'
        WHERE id = ANY(${ids})
          AND enrichment_level = 'indexed'
      `;
      updated = result.count;
    }

    return { updated, ids };
  });

  // POST /admin/curation/requeue — re-queue already-extracted sites for a fresh
  // extraction pass (extracted→queued).
  //
  // Distinct endpoint from /queue on purpose: the two intents must not share a
  // button. /queue is the first pass (indexed→queued); this is the explicit
  // re-extraction path, used when the pipeline has moved on since a site's
  // original extraction and its timeline should be rebuilt.
  //
  // The gate here is the mirror image (enrichment_level='extracted'), so this
  // path can ONLY touch already-extracted sites and can never resurrect an
  // indexed/excluded one. Once re-queued, the batch extractor
  // (/admin/extract/stream) picks the site up like any other queued site and
  // overwrites its timeline — that machinery already ignores the prior level, so
  // nothing else is needed downstream.
  app.post<{
    Body: { site_ids: string[] };
  }>("/admin/curation/requeue", async (req, reply) => {
    const sql = getSql();
    const ids: string[] = req.body?.site_ids ?? [];

    let updated = 0;
    if (ids.length > 0) {
      const result = await sql`
        UPDATE sites
        SET enrichment_level = 'queued'
        WHERE id = ANY(${ids})
          AND enrichment_level = 'extracted'
      `;
      updated = result.count;
    }

    return { updated, ids };
  });
};
