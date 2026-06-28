// routes/api/cultures.ts
import type { FastifyPluginAsync } from "fastify";
import { getAllCultures } from "@strabon/db";

export const apiCulturesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cultures", async (_req, reply) => {
    const cultures = await getAllCultures();
    return reply.send(cultures);
  });
};
