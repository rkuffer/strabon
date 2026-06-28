// packages/server/src/routes/admin/cultures.ts
import type { FastifyPluginAsync } from "fastify";
import { getAllCultures, upsertCulture } from "@strabon/db";

export const adminCulturesRoutes: FastifyPluginAsync = async (app) => {

  app.get("/admin/cultures", async (_req, reply) => {
    const cultures = await getAllCultures();
    return reply.view("admin/cultures/index", {
      title:    "Cultures — Admin",
      cultures,
    });
  });

  app.post<{
    Body: { wikidata_id: string; name: string; type?: string; color?: string; wikipedia_url?: string };
  }>("/admin/cultures", async (req, reply) => {
    await upsertCulture(req.body);
    return reply.redirect("/admin/cultures");
  });

  app.patch<{
    Params: { id: string };
    Body: { color?: string; type?: string };
  }>("/admin/cultures/:id", async (req, reply) => {
    const { getSql } = await import("@strabon/db");
    const sql = getSql();
    const { color, type } = req.body;
    await sql`
      UPDATE cultures SET
        color = COALESCE(${color ?? null}, color),
        type  = COALESCE(${type  ?? null}, type)
      WHERE wikidata_id = ${req.params.id}
    `;
    return reply.send({ ok: true });
  });
};
