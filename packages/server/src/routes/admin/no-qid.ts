// packages/server/src/routes/admin/no-qid.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";

// Lists sites whose timeline has referential-track entries WITHOUT a QID — the
// red "no QID" entries the /admin/sites editor shows. Purpose: quick inspection
// and triage (each site links straight to its editor, where the QID modal fixes
// them). This is site-centric and complements the entity-centric /admin/gaps.
//
// NOT heavy: only EXTRACTED sites carry a timeline (a tiny slice of the 2M+ L0
// set), and the enrichment_level prefilter is indexed (idx_sites_enrichment), so
// the JSONB scan is bounded by the extracted count.
const REF_TRACKS = ["polity", "culture", "religion", "language"];
const LIMIT = 500;

export const adminNoQidRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { track?: string; q?: string } }>(
    "/admin/no-qid",
    async (req, reply) => {
      const sql = getSql();
      const track = REF_TRACKS.includes(req.query.track ?? "")
        ? (req.query.track as string)
        : null;
      const tracks = track ? [track] : REF_TRACKS;
      const q = (req.query.q ?? "").trim();

      // Unnest the chosen referential tracks, expand their entries array (guarded
      // against a missing/non-array track), keep only entries with no wikidata,
      // then group per site with the list of missing (track, name) pairs.
      const rows = await sql`
        SELECT s.id, s.title_en, s.enrichment_level, s.base_importance,
               count(*)::int AS n,
               jsonb_agg(
                 jsonb_build_object(
                   'track', t.track,
                   'name', coalesce(e.entry -> 'value' ->> 'name', '(sans nom)')
                 ) ORDER BY t.track
               ) AS missing
        FROM sites s
        CROSS JOIN unnest(${tracks}::text[]) AS t(track)
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.timeline -> t.track -> 'entries') = 'array'
               THEN s.timeline -> t.track -> 'entries'
               ELSE '[]'::jsonb END
        ) AS e(entry)
        WHERE s.enrichment_level = 'extracted'
          AND s.timeline IS NOT NULL
          AND NULLIF(e.entry -> 'value' ->> 'wikidata', '') IS NULL
          ${q ? sql`AND s.title_en ILIKE ${"%" + q + "%"}` : sql``}
        GROUP BY s.id, s.title_en, s.enrichment_level, s.base_importance
        ORDER BY n DESC, s.base_importance DESC NULLS LAST, s.title_en
        LIMIT ${LIMIT + 1}
      `;

      const truncated = rows.length > LIMIT;
      const sites = (rows as any[]).slice(0, LIMIT);
      const totalEntries = sites.reduce((a, s) => a + s.n, 0);

      return reply.view("admin/no-qid/index", {
        title: "Sans QID — Admin",
        sites,
        truncated,
        limit: LIMIT,
        totalEntries,
        track: track ?? "all",
        q,
        tracks: REF_TRACKS,
      });
    },
  );
};
