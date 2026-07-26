// packages/server/src/routes/admin/attributions.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";
import { formatYear } from "@strabon/shared";

// Lists site_attributions GROUPED BY ENTITY. Its operational purpose is the
// culture-attribution bottleneck: attributions are known for ~600 sites but only
// a handful are extracted, and hulls read the timeline — so this view surfaces,
// per entity, which attributed sites are still un-extracted and lets one queue
// them for extraction (reusing POST /admin/curation/queue) without leaving the
// page. Future-proof for the other kinds once extraction writes attributions back.
export const adminAttributionsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: { kind?: string; hide_done?: string; q?: string };
  }>("/admin/attributions", async (req, reply) => {
    const sql = getSql();
    const kind =
      req.query.kind && req.query.kind !== "all" ? req.query.kind : null;
    const hideDone = req.query.hide_done === "1";
    const q = (req.query.q ?? "").trim();

    // One row per (entity, site); grouped in JS so the "most queueable first"
    // ordering can be computed after aggregation.
    const rows = await sql`
      SELECT a.entity_qid,
             a.kind        AS attr_kind,
             we.label_en   AS entity_label,
             we.active     AS entity_active,
             we.inception, we.inception_precision,
             we.dissolution, we.dissolution_precision,
             s.id          AS site_id,
             s.title_en,
             s.enrichment_level,
             s.base_importance
      FROM site_attributions a
      JOIN wikidata_entities we ON we.qid = a.entity_qid
      JOIN sites s              ON s.id  = a.site_id
      WHERE TRUE
        ${kind ? sql`AND a.kind = ${kind}` : sql``}
        ${q ? sql`AND we.label_en ILIKE ${"%" + q + "%"}` : sql``}
      ORDER BY we.label_en, s.base_importance DESC NULLS LAST, s.title_en
    `;

    const fmt = (year: number | null, prec: number | null) =>
      year == null ? null : formatYear({ year, precision: prec ?? 9 });

    const map = new Map<string, any>();
    for (const r of rows as any[]) {
      let g = map.get(r.entity_qid);
      if (!g) {
        const from = fmt(r.inception, r.inception_precision);
        const to = fmt(r.dissolution, r.dissolution_precision);
        g = {
          qid: r.entity_qid,
          label: r.entity_label,
          kind: r.attr_kind,
          active: r.entity_active,
          dates:
            from == null && to == null
              ? null
              : `${from ?? "?"} → ${to ?? "…"}`,
          sites: [],
          nExtracted: 0,
          nQueued: 0,
          nIndexed: 0,
          nExcluded: 0,
        };
        map.set(r.entity_qid, g);
      }
      g.sites.push({
        id: r.site_id,
        title: r.title_en,
        level: r.enrichment_level || "indexed",
        importance: r.base_importance,
      });
      const lvl = r.enrichment_level || "indexed";
      if (lvl === "extracted") g.nExtracted++;
      else if (lvl === "queued") g.nQueued++;
      else if (lvl === "excluded") g.nExcluded++;
      else g.nIndexed++;
    }

    let entities = [...map.values()];
    // "hide done" = drop entities with nothing left to queue.
    if (hideDone) entities = entities.filter((e) => e.nIndexed > 0);
    // Most queueable first — the actionable entities rise to the top.
    entities.sort(
      (a, b) =>
        b.nIndexed - a.nIndexed ||
        b.sites.length - a.sites.length ||
        String(a.label).localeCompare(String(b.label)),
    );

    const totals = {
      entities: entities.length,
      sites: entities.reduce((n, e) => n + e.sites.length, 0),
      queueable: entities.reduce((n, e) => n + e.nIndexed, 0),
    };

    const kinds = [...new Set((rows as any[]).map((r) => r.attr_kind))].sort();

    return reply.view("admin/attributions/index", {
      title: "Attributions — Admin",
      entities,
      totals,
      kinds,
      kind: kind ?? "all",
      hideDone,
      q,
    });
  });
};
