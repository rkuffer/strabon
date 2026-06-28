// routes/pages/polities.ts
import type { FastifyPluginAsync } from "fastify";
import { getAllPolities } from "@strabon/db";

export const pagePolitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/polities", async (_req, reply) => {
    const polities = await getAllPolities();
    return reply.view("polities/index", {
      title: "Polities — Strabon",
      polities,
    });
  });
};
