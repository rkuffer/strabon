// packages/server/src/routes/admin/gaps.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";
import { autoResolveGaps, resolveGapManually, rejectGap } from "@strabon/db";

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
               g.site_ids, g.occurrences, g.status, g.resolved_qid,
               g.resolution_note, g.first_seen_at, g.last_seen_at,
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

    // A proposed QID that appears on TWO UNRELATED gaps is a red flag: the model
    // has reached for a generic or invented identifier. Q41137 was proposed for
    // both "Old Assyrian city-state" (Assur) and "Greek colony (Phocaean)" (Nice)
    // — two entities with nothing in common. Verification will catch it, but the
    // duplication is free evidence and worth surfacing.
    const qidUses = new Map<string, number>();
    for (const g of gaps as any[]) {
      if (g.proposed_qid) {
        qidUses.set(g.proposed_qid, (qidUses.get(g.proposed_qid) ?? 0) + 1);
      }
    }

    const enriched = (gaps as any[]).map((g: any) => ({
      ...g,
      sites: (g.site_ids ?? []).map((id: string) => ({
        id,
        title: siteTitles.get(id) ?? id,
      })),
      // The entries that produced the gap — the real context.
      occurrences: (g.occurrences ?? []).map((o: any) => ({
        ...o,
        site_title: siteTitles.get(o.site_id) ?? o.site_id,
      })),
      proposed_qid_reused:
        g.proposed_qid && (qidUses.get(g.proposed_qid) ?? 0) > 1,
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

  // GET /admin/gaps/search-entities?q=…&kind=… — search OUR referential (not
  // Wikidata), so a gap can be resolved to an entity that already exists under a
  // DIFFERENT name. The model writes "Hittite Empire" (no QID); our polity
  // referential has that entity as "Hatti". Searching label_en + search_text
  // (which carries FR label + aliases) + description_en surfaces Hatti; picking
  // its QID and resolving then backfills the "Hittite Empire" timeline entries.
  // `active` gate: never propose an invalidated entity.
  app.get<{ Querystring: { q?: string; kind?: string } }>(
    "/admin/gaps/search-entities",
    async (req, reply) => {
      const sql = getSql();
      const q = (req.query.q ?? "").trim();
      if (q.length < 2) return reply.send({ results: [] });
      const kind = req.query.kind;
      const like = `%${q}%`;
      const results = await sql`
        SELECT qid, kind, label_en, description_en, family_label
        FROM wikidata_entities
        WHERE active
          ${kind && kind !== "all" ? sql`AND kind = ${kind}` : sql``}
          AND (label_en ILIKE ${like}
               OR search_text ILIKE ${like}
               OR description_en ILIKE ${like})
        ORDER BY
          CASE
            WHEN label_en ILIKE ${q} THEN 0
            WHEN label_en ILIKE ${q + "%"} THEN 1
            ELSE 2
          END,
          label_en
        LIMIT 10
      `;
      return reply.send({ results });
    },
  );
};
