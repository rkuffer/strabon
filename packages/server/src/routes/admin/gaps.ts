// packages/server/src/routes/admin/gaps.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";
import {
  autoResolveGaps,
  resolveGapManually,
  rejectGap,
} from "../../agent/referential-gaps.js";

export const adminGapsRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/gaps — list referential gaps
  app.get<{
    Querystring: { status?: string; kind?: string };
  }>("/admin/gaps", async (req, reply) => {
    const sql = getSql();
    const { status = "pending", kind } = req.query;

    const conditions: string[] = [];
    if (status && status !== "all") {
      conditions.push(`g.status = '${status.replace(/'/g, "''")}'`);
    }
    if (kind && kind !== "all") {
      conditions.push(`g.kind = '${kind.replace(/'/g, "''")}'`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [gaps, counts] = await Promise.all([
      sql.unsafe(`
        SELECT g.id, g.kind, g.name, g.context, g.proposed_qid,
               g.site_ids, g.status, g.resolved_qid, g.resolution_note,
               g.first_seen_at, g.last_seen_at,
               COALESCE(array_length(g.site_ids, 1), 0) AS site_count
        FROM referential_gaps g
        ${where}
        ORDER BY
          CASE g.status WHEN 'pending' THEN 0 ELSE 1 END,
          COALESCE(array_length(g.site_ids, 1), 0) DESC,
          g.first_seen_at
        LIMIT 200
      `),
      sql`
        SELECT status, kind, COUNT(*)::int AS count
        FROM referential_gaps
        GROUP BY status, kind
      `,
    ]);

    // Resolve the titles of the signalling sites, so the view can show names
    // rather than bare QIDs.
    const allSiteIds = [
      ...new Set(gaps.flatMap((g: any) => (g.site_ids ?? []) as string[])),
    ];
    const siteTitles = new Map<string, string>();
    if (allSiteIds.length) {
      const rows = await sql`
        SELECT id, title_en FROM sites WHERE id = ANY(${allSiteIds})
      `;
      for (const r of rows as any[]) siteTitles.set(r.id, r.title_en);
    }

    const enriched = gaps.map((g: any) => ({
      ...g,
      sites: (g.site_ids ?? []).map((id: string) => ({
        id,
        title: siteTitles.get(id) ?? id,
      })),
    }));

    // Counters for the header
    const pending = counts
      .filter((c: any) => c.status === "pending")
      .reduce((n: number, c: any) => n + c.count, 0);
    const resolved = counts
      .filter((c: any) => c.status === "resolved")
      .reduce((n: number, c: any) => n + c.count, 0);
    const rejected = counts
      .filter((c: any) => c.status === "rejected")
      .reduce((n: number, c: any) => n + c.count, 0);

    const pendingByKind = counts
      .filter((c: any) => c.status === "pending")
      .map((c: any) => ({ kind: c.kind, count: c.count }))
      .sort((a: any, b: any) => b.count - a.count);

    return reply.view("admin/gaps/index", {
      title: "Referential gaps — Admin",
      gaps: enriched,
      status,
      kind,
      pending,
      resolved,
      rejected,
      pendingByKind,
    });
  });

  // POST /admin/gaps/auto — run the deterministic auto-resolution pass
  app.post<{ Body: { dry_run?: boolean } }>(
    "/admin/gaps/auto",
    async (req, reply) => {
      const sql = getSql();
      const dryRun = req.body?.dry_run ?? false;

      const outcomes = await autoResolveGaps(sql, { dryRun });

      return reply.send({
        ok: true,
        dry_run: dryRun,
        resolved: outcomes.filter((o) => o.action === "resolved"),
        needs_review: outcomes.filter((o) => o.action === "needs_review"),
      });
    },
  );

  // POST /admin/gaps/:id/resolve — resolve one gap with a human-supplied QID
  app.post<{
    Params: { id: string };
    Body: { qid: string; family?: string };
  }>("/admin/gaps/:id/resolve", async (req, reply) => {
    const sql = getSql();
    const gapId = parseInt(req.params.id, 10);
    const { qid, family } = req.body ?? {};

    if (!qid || !/^Q\d+$/.test(qid)) {
      return reply.status(400).send({ error: "A valid QID is required" });
    }

    try {
      const outcome = await resolveGapManually(sql, gapId, qid, family);
      return reply.send({ ok: true, ...outcome });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? String(err) });
    }
  });

  // POST /admin/gaps/:id/reject — mark a gap as not worth referencing
  app.post<{
    Params: { id: string };
    Body: { note?: string };
  }>("/admin/gaps/:id/reject", async (req, reply) => {
    const sql = getSql();
    const gapId = parseInt(req.params.id, 10);

    await rejectGap(sql, gapId, req.body?.note);
    return reply.send({ ok: true });
  });
};
