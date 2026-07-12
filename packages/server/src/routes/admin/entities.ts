// packages/server/src/routes/admin/entities.ts
// =============================================================================
// Unified referential browser — /admin/entities
//
// Replaces the legacy /admin/polities and /admin/cultures views, which read the
// old `polities` / `cultures` tables. The real referential is now
// `wikidata_entities`: it is what feeds the extraction prompt, it carries all four
// kinds (polity, culture, religion, language), and it is where family_qid lives.
//
// One view, a kind selector, search, family filter — plus a usage count, which is
// the number that actually matters: an entity nobody uses is dead weight in the
// prompt, and a heavily-used entity is one whose QID had better be right.
// =============================================================================

import type { FastifyPluginAsync } from "fastify";
import { getSql } from "@strabon/db";

const KINDS = ["polity", "culture", "religion", "language"] as const;
type Kind = (typeof KINDS)[number];

export const adminEntitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: {
      kind?: string;
      q?: string;
      family?: string;
      sort?: string;
      unused?: string;
    };
  }>("/admin/entities", async (req, reply) => {
    const sql = getSql();

    const kind = (KINDS as readonly string[]).includes(req.query.kind ?? "")
      ? (req.query.kind as Kind)
      : "religion";
    const q = (req.query.q ?? "").trim();
    const family = (req.query.family ?? "").trim();
    const sort = req.query.sort === "label" ? "label" : "usage";
    const unusedOnly = req.query.unused === "1";

    // ── Usage counts ─────────────────────────────────────────────────────────
    // How many EXTRACTED sites reference each QID on this kind's own track.
    // Restricted to enrichment_level='extracted': indexed sites (L0) have no
    // timeline, and scanning them would be pointless as well as slow.
    const usageRows = await sql`
      SELECT entry.value -> 'value' ->> 'wikidata' AS qid,
             COUNT(DISTINCT s.id)::int AS n
      FROM sites s
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(s.timeline -> ${kind} -> 'entries', '[]'::jsonb)
      ) AS entry(value)
      WHERE s.enrichment_level = 'extracted'
        AND s.timeline IS NOT NULL
        AND entry.value -> 'value' ->> 'wikidata' IS NOT NULL
      GROUP BY 1
    `;
    const usage = new Map<string, number>(
      usageRows.map((r: any) => [r.qid, r.n]),
    );

    // ── Entities ─────────────────────────────────────────────────────────────
    const rows = await sql`
      SELECT qid, label_en, description_en, kind, family_qid, family_label
      FROM wikidata_entities
      WHERE kind = ${kind}
        ${q ? sql`AND (label_en ILIKE ${"%" + q + "%"} OR description_en ILIKE ${"%" + q + "%"} OR qid ILIKE ${"%" + q + "%"})` : sql``}
        ${family ? sql`AND family_label = ${family}` : sql``}
      ORDER BY label_en
    `;

    let entities = rows.map((r: any) => ({
      ...r,
      usage: usage.get(r.qid) ?? 0,
    }));

    if (unusedOnly) entities = entities.filter((e: any) => e.usage === 0);

    if (sort === "usage") {
      entities.sort(
        (a: any, b: any) =>
          b.usage - a.usage || a.label_en.localeCompare(b.label_en),
      );
    }

    // ── Families, for the filter ──────────────────────────────────────────────
    const familyRows = await sql`
      SELECT family_label, COUNT(*)::int AS n
      FROM wikidata_entities
      WHERE kind = ${kind} AND family_label IS NOT NULL
      GROUP BY family_label
      ORDER BY family_label
    `;

    // ── Counts per kind, for the tabs ────────────────────────────────────────
    const kindRows = await sql`
      SELECT kind, COUNT(*)::int AS n
      FROM wikidata_entities
      WHERE kind = ANY(${[...KINDS]})
      GROUP BY kind
    `;
    const kindCounts: Record<string, number> = {};
    for (const r of kindRows as any[]) kindCounts[r.kind] = r.n;

    const used = entities.filter((e: any) => e.usage > 0).length;

    return reply.view("admin/entities/index", {
      title: "Referential — Admin",
      kinds: KINDS,
      kind,
      kindCounts,
      entities,
      families: familyRows,
      q,
      family,
      sort,
      unusedOnly,
      stats: {
        total: entities.length,
        used,
        unused: entities.length - used,
      },
    });
  });
};
