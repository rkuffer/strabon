// routes/api/polities.ts
import type { FastifyPluginAsync } from "fastify";
import { getAllPolities } from "@strabon/db";

export const apiPolitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/polities", async (_req, reply) => {
    const polities = await getAllPolities();
    return reply.send(polities);
  });
};
