// packages/server/src/routes/admin/sites.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql, getSiteById } from "@strabon/db";

export const adminSitesRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/sites — liste avec filtres
  app.get<{
    Querystring: {
      q?: string;
      status?: "no_timeline" | "no_coords" | "no_enrich" | "all";
      country?: string;
      page?: string;
    };
  }>("/admin/sites", async (req, reply) => {
    const sql = getSql();
    const { q, status = "all", country, page = "1" } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const conditions: string[] = [];
    if (q) conditions.push(`s.title_en ILIKE '%${q.replace(/'/g, "''")}%'`);
    if (status === "no_timeline") conditions.push(`s.timeline IS NULL`);
    if (status === "no_coords") conditions.push(`s.location IS NULL`);
    if (status === "no_enrich")
      conditions.push(`s.wikidata_enriched_at IS NULL`);
    if (country)
      conditions.push(`s.country_qid = '${country.replace(/'/g, "''")}'`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [sites, totalRow, countries] = await Promise.all([
      sql.unsafe(`
        SELECT s.id, s.title_en,
               c.name_en AS country_name,
               s.site_type, s.base_importance,
               s.sitelinks_count, s.enrichment_level,
               s.inception_year, s.dissolution_year,
               s.timeline IS NOT NULL             AS has_timeline,
               s.location IS NOT NULL             AS has_coords,
               s.wikidata_enriched_at IS NOT NULL AS has_enrich,
               s.timeline_extracted_at
        FROM sites s
        LEFT JOIN countries c ON c.qid = s.country_qid
        ${where}
        ORDER BY s.sitelinks_count DESC NULLS LAST, s.title_en
        LIMIT ${limit} OFFSET ${offset}
      `),
      sql.unsafe(`SELECT COUNT(*)::int AS count FROM sites s ${where}`),
      sql`SELECT c.qid, c.name_en FROM countries c ORDER BY c.name_en`,
    ]);

    return reply.view("admin/sites/index", {
      title: "Sites — Admin",
      sites,
      total: totalRow[0].count,
      page: parseInt(page),
      pages: Math.ceil(totalRow[0].count / limit),
      q,
      status,
      country,
      countries,
      limit,
    });
  });

  // GET /admin/sites/:id — fiche site
  app.get<{ Params: { id: string } }>(
    "/admin/sites/:id",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site)
        return reply.status(404).view("errors/404", { title: "Not found" });

      // getSiteById does not join the countries table nor carry the enrichment
      // columns the detail view now shows. Fetch them separately and merge.
      const sql = getSql();
      const rows = await sql`
        SELECT c.name_en AS country_name,
               s.sitelinks_count,
               s.population,
               s.enrichment_level
        FROM sites s
        LEFT JOIN countries c ON c.qid = s.country_qid
        WHERE s.id = ${req.params.id}
      `;

      const extra = rows[0] ?? {};

      return reply.view("admin/sites/show", {
        title: `${site.title_en} — Admin`,
        site: { ...site, ...extra },
      });
    },
  );
};
