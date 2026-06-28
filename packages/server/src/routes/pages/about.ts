// routes/pages/about.ts
import type { FastifyPluginAsync } from "fastify";

export const pageAboutRoutes: FastifyPluginAsync = async (app) => {
  app.get("/about", async (_req, reply) => {
    return reply.view("about", { title: "About — Strabon" });
  });
};
