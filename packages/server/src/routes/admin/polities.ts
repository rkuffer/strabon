// packages/server/src/routes/admin/polities.ts
import type { FastifyPluginAsync } from "fastify";
import { getAllPolities, upsertPolity } from "@strabon/db";

export const adminPolitiesRoutes: FastifyPluginAsync = async (app) => {

  app.get("/admin/polities", async (_req, reply) => {
    const polities = await getAllPolities();
    return reply.view("admin/polities/index", {
      title:    "Polities — Admin",
      polities,
    });
  });

  app.post<{
    Body: { wikidata_id: string; name: string; type?: string; color?: string; wikipedia_url?: string };
  }>("/admin/polities", async (req, reply) => {
    await upsertPolity(req.body);
    return reply.redirect("/admin/polities");
  });

  // PATCH /admin/polities/:id — mise à jour couleur/type (appelé par l'UI Vue admin)
  app.patch<{
    Params: { id: string };
    Body: { color?: string; type?: string };
  }>("/admin/polities/:id", async (req, reply) => {
    const { getSql } = await import("@strabon/db");
    const sql = getSql();
    const { color, type } = req.body;
    await sql`
      UPDATE polities SET
        color = COALESCE(${color ?? null}, color),
        type  = COALESCE(${type  ?? null}, type)
      WHERE wikidata_id = ${req.params.id}
    `;
    return reply.send({ ok: true });
  });
};
