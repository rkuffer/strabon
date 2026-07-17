// packages/server/src/routes/admin/dashboard.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";

export const adminDashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/admin", async (_req, reply) => {
    const sql = getSql();

    const [
      totalRow,
      withCoordsRow,
      withTimelineRow,
      withImportanceRow,
      noTimelineRow,
      recentRow,
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM sites`,
      sql`SELECT COUNT(*)::int AS count FROM sites WHERE location IS NOT NULL`,
      sql`SELECT COUNT(*)::int AS count FROM sites WHERE timeline IS NOT NULL`,
      sql`SELECT COUNT(*)::int AS count FROM sites WHERE base_importance > 0`,
      sql`SELECT COUNT(*)::int AS count FROM sites WHERE timeline IS NULL AND location IS NOT NULL`,
      sql`SELECT id, title_en, last_updated FROM sites ORDER BY last_updated DESC LIMIT 5`,
    ]);

    const stats = {
      total:        totalRow[0].count,
      withCoords:   withCoordsRow[0].count,
      withTimeline: withTimelineRow[0].count,
      withImportance: withImportanceRow[0].count,
      noTimeline:   noTimelineRow[0].count,
    };

    return reply.view("admin/dashboard", {
      title:  "Admin — Strabon",
      stats,
      recent: recentRow,
    });
  });
};
