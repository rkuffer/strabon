// packages/server/src/routes/admin/bounds.ts
//
// The bounds-conflict review.
//
// This is NOT a task queue. It is an INSTRUMENT.
//
// A conflict means an entry and its entity are irreconcilable — the entry lies
// entirely outside the entity's life — and we cannot know which of the two is
// wrong. The pipeline therefore changes NOTHING and records the contradiction.
//
// Grouped BY ENTITY rather than by site, because that is where the signal is.
// Fifteen sites carrying "Kingdom of France, from 1814" while the entity died in
// 1791 is not fifteen mistakes: it is ONE mistake, made fifteen times. The model
// used Q70972 (the ancien régime) for the Bourbon Restoration — and on Bordeaux
// and Paris it used "Bourbon Restoration in France", correctly.
//
// Same prompt, same fact, two granularities. That is the model's real failure
// mode — an unstable granularity policy, not hallucination — and bounds make it
// measurable, at scale, without human judgement.
//
// Read-only, deliberately. We will know which buttons this page needs once we
// have looked at it for a while. Building them now would be guessing.

import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";

export const adminBoundsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { track?: string } }>(
    "/admin/bounds",
    async (req, reply) => {
      const sql = getSql();
      const { track } = req.query;

      const rows = await sql`
        SELECT
          c.entity_qid,
          c.entity_label,
          c.track,
          c.entity_inception,
          c.entity_dissolution,
          e.description_en,
          e.bounds_source,
          e.bounds_confirmed,
          COUNT(*)::INT AS occurrences,
          jsonb_agg(
            jsonb_build_object(
              'site_id',    c.site_id,
              'site_title', s.title_en,
              'entry_from', c.entry_from,
              'entry_to',   c.entry_to,
              'detail',     c.detail
            )
            ORDER BY s.title_en
          ) AS entries
        FROM bounds_conflicts c
        JOIN sites s ON s.id = c.site_id
        LEFT JOIN wikidata_entities e ON e.qid = c.entity_qid
        WHERE c.status = 'pending'
          ${track && track !== "all" ? sql`AND c.track = ${track}` : sql``}
        GROUP BY
          c.entity_qid, c.entity_label, c.track,
          c.entity_inception, c.entity_dissolution,
          e.description_en, e.bounds_source, e.bounds_confirmed
        ORDER BY COUNT(*) DESC, c.entity_label
      `;

      const byTrack = await sql`
        SELECT track, COUNT(*)::INT AS count
        FROM bounds_conflicts
        WHERE status = 'pending'
        GROUP BY track
        ORDER BY COUNT(*) DESC
      `;

      const total = (byTrack as any[]).reduce(
        (n, r) => n + Number(r.count),
        0,
      );

      return reply.view("admin/bounds/index", {
        title: "Bound conflicts — Admin",
        groups: rows,
        byTrack,
        total,
        entities: (rows as any[]).length,
        track: track ?? "all",
      });
    },
  );
};
