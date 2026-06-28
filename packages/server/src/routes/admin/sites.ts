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

    // Construction dynamique du WHERE
    const conditions: string[] = [];
    if (q) conditions.push(`title_en ILIKE '%${q.replace(/'/g, "''")}%'`);
    if (status === "no_timeline") conditions.push(`timeline IS NULL`);
    if (status === "no_coords") conditions.push(`location IS NULL`);
    if (status === "no_enrich") conditions.push(`wikidata_enriched_at IS NULL`);
    if (country) conditions.push(`country = '${country.replace(/'/g, "''")}'`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [sites, totalRow, countries] = await Promise.all([
      sql.unsafe(`
        SELECT id, title_en, country, site_type, base_importance,
               inception_year, dissolution_year,
               timeline IS NOT NULL         AS has_timeline,
               location IS NOT NULL         AS has_coords,
               wikidata_enriched_at IS NOT NULL AS has_enrich,
               timeline_extracted_at
        FROM sites
        ${where}
        ORDER BY base_importance DESC, title_en
        LIMIT ${limit} OFFSET ${offset}
      `),
      sql.unsafe(`SELECT COUNT(*)::int AS count FROM sites ${where}`),
      sql`SELECT DISTINCT country FROM sites WHERE country IS NOT NULL ORDER BY country`,
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
      countries: countries.map((r: any) => r.country),
      limit,
    });
  });

  // GET /admin/sites/:id — fiche site
  app.get<{ Params: { id: string } }>(
    "/admin/sites/:id",
    async (req, reply) => {
      const site = await getSiteById(req.params.id);
      console.log("site keys:", site ? Object.keys(site) : "null");
      console.log("names type:", typeof site?.names);
      console.log("meta type:", typeof site?.meta);
      console.log("timeline type:", typeof site?.timeline);
      if (!site)
        return reply.status(404).view("errors/404", { title: "Not found" });

      return reply.view("admin/sites/show", {
        title: `${site.title_en} — Admin`,
        site,
      });
    },
  );
};
