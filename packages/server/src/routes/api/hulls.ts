// routes/api/hulls.ts
import type { FastifyPluginAsync } from "fastify";
import { queryPolityHulls, queryCultureHulls } from "@strabon/db";

export const apiHullsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { year: string; type?: string } }>("/hulls", async (req, reply) => {
    const year = parseInt(req.query.year ?? "0", 10);
    const type = req.query.type ?? "both";

    const [polities, cultures] = await Promise.all([
      type !== "culture" ? queryPolityHulls(year) : [],
      type !== "polity"  ? queryCultureHulls(year) : [],
    ]);

    return reply.send({
      type: "FeatureCollection",
      features: [...polities, ...cultures],
    });
  });
};
