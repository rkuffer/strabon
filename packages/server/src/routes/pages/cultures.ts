// routes/pages/cultures.ts
import type { FastifyPluginAsync } from "fastify";
import { getAllCultures } from "@strabon/db";

export const pageCulturesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cultures", async (_req, reply) => {
    const cultures = await getAllCultures();
    return reply.view("cultures/index", {
      title: "Cultures — Strabon",
      cultures,
    });
  });
};
