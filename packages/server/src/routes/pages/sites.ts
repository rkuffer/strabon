// routes/pages/sites.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";

export const pageSitesRoutes: FastifyPluginAsync = async (app) => {
  // GET /sites — liste de tous les sites
  app.get("/sites", async (_req, reply) => {
    const sql = getSql();
    const sites = await sql`
      SELECT id, title_en, country, site_type,
             inception_year, dissolution_year, base_importance
      FROM sites
      ORDER BY base_importance DESC, title_en
      LIMIT 500
    `;
    return reply.view("sites/index", {
      title: "Sites — Strabon",
      sites,
    });
  });

  // GET /sites/:id — page détail d'un site
  app.get<{ Params: { id: string } }>("/sites/:id", async (req, reply) => {
    const { getSiteById } = await import("@strabon/db");
    const site = await getSiteById(req.params.id);
    if (!site) return reply.status(404).view("errors/404", { title: "Not found" });
    return reply.view("sites/show", {
      title: `${site.title_en} — Strabon`,
      site,
    });
  });
};
