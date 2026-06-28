// routes/api/sites.ts
import type { FastifyPluginAsync } from "fastify";
import { querySites, searchSites } from "@strabon/db";
import { getZoomThreshold } from "@strabon/shared";

export const apiSitesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: {
      year: string;
      zoom: string;
      minLon: string;
      minLat: string;
      maxLon: string;
      maxLat: string;
      filter?: "timeline_only" | "all" | "no_timeline";
    };
  }>("/sites", async (req, reply) => {
    const year = parseInt(req.query.year ?? "0", 10);
    const zoom = parseFloat(req.query.zoom ?? "3");
    const minLon = parseFloat(req.query.minLon ?? "-180");
    const minLat = parseFloat(req.query.minLat ?? "-90");
    const maxLon = parseFloat(req.query.maxLon ?? "180");
    const maxLat = parseFloat(req.query.maxLat ?? "90");
    const filter = req.query.filter ?? "timeline_only";

    const threshold = getZoomThreshold(zoom);

    const sites = await querySites({
      year,
      zoom,
      threshold,
      filter,
      bboxMinLon: minLon,
      bboxMinLat: minLat,
      bboxMaxLon: maxLon,
      bboxMaxLat: maxLat,
    });

    return reply.send(sites);
  });

  // GET /api/search?q=...&limit=... — recherche souple par nom (tous noms connus)
  // Indépendante de l'année / du bbox / du zoom : trouve un site n'importe où
  // pour recentrer la carte dessus.
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/search",
    async (req, reply) => {
      const q = (req.query.q ?? "").trim();
      // En dessous de 2 caractères, trop de bruit — on renvoie vide.
      if (q.length < 2) return reply.send([]);
      const limit = Math.min(
        Math.max(parseInt(req.query.limit ?? "8", 10) || 8, 1),
        20,
      );
      const results = await searchSites(q, limit);
      return reply.send(results);
    },
  );

  app.get<{ Params: { id: string } }>("/sites/:id", async (req, reply) => {
    const { getSiteById } = await import("@strabon/db");
    const site = await getSiteById(req.params.id);
    if (!site) return reply.status(404).send({ error: "Site not found" });
    return reply.send(site);
  });
};
