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
    if (q) conditions.push(`(s.title_en ILIKE '%${q.replace(/'/g, "''")}%' OR s.meta->>'wikidata_description' ILIKE '%${q.replace(/'/g, "''")}%')`);
    if (level && level !== "all") conditions.push(`s.enrichment_level = '${level}'`);
    if (country) conditions.push(`s.country_qid = '${country.replace(/'/g, "''")}'`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [sites, totalRow, countries, levelCounts] = await Promise.all([
      sql.unsafe(`
        SELECT s.id, s.title_en,
               s.country_qid,
               c.name_en AS country_name,
               s.enrichment_level,
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
        ORDER BY s.sitelinks_count DESC NULLS LAST, s.title_en
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
};
