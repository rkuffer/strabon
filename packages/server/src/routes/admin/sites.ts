// packages/server/src/routes/admin/sites.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql, getSiteById } from "@strabon/db";

export const adminSitesRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/sites — liste avec filtres
  app.get<{
    Querystring: {
      q?: string;
      status?: "no_timeline" | "no_coords" | "all";
      country?: string;
      page?: string;
    };
  }>("/admin/sites", async (req, reply) => {
    const sql = getSql();
    const { q, status = "all", country, page = "1" } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const conditions: string[] = [];
    const qEsc = q ? q.replace(/'/g, "''") : "";
    if (q) conditions.push(`s.title_en ILIKE '%${qEsc}%'`);
    if (status === "no_timeline") conditions.push(`s.timeline IS NULL`);
    if (status === "no_coords") conditions.push(`s.location IS NULL`);
    if (country)
      conditions.push(`s.country_qid = '${country.replace(/'/g, "''")}'`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Avec une recherche texte : correspondance exacte du titre d'abord, puis
    // les titres qui commencent par la requête, puis le reste — importance en
    // tie-break. Sans recherche : ordre habituel piloté par l'importance.
    // (même logique que /admin/curation)
    const orderBy = q
      ? `CASE
           WHEN lower(s.title_en) = lower('${qEsc}') THEN 0
           WHEN s.title_en ILIKE '${qEsc}%' THEN 1
           ELSE 2
         END,
         s.base_importance DESC NULLS LAST, s.title_en`
      : `s.base_importance DESC NULLS LAST, s.title_en`;

    const [sites, totalRow, countries] = await Promise.all([
      sql.unsafe(`
        SELECT s.id, s.title_en,
               c.name_en AS country_name,
               s.site_type, s.base_importance,
               s.sitelinks_count, s.wikipedia_page_en_url, s.enrichment_level,
               s.inception_year, s.dissolution_year,
               s.timeline IS NOT NULL             AS has_timeline,
               s.location IS NOT NULL             AS has_coords,
               s.timeline_extracted_at
        FROM sites s
        LEFT JOIN countries c ON c.qid = s.country_qid
        ${where}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}
      `),
      sql.unsafe(`SELECT COUNT(*)::int AS count FROM sites s ${where}`),
      sql`SELECT c.qid, c.name_en FROM countries c ORDER BY c.name_en`,
    ]);

    return reply.view("admin/sites/index", {
      title: "Sites — Admin",
      sites,
      total: totalRow[0].count,
      page: parseInt(page),
      pages: Math.ceil(totalRow[0].count / limit),
      q,
      status,
      country,
      countries,
      limit,
    });
  });

  // GET /admin/sites/:id — fiche site
  app.get<{ Params: { id: string } }>(
    "/admin/sites/:id",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site)
        return reply.status(404).view("errors/404", { title: "Not found" });

      // getSiteById does not join the countries table nor carry the enrichment
      // columns the detail view now shows. Fetch them separately and merge.
      const sql = getSql();
      const rows = await sql`
        SELECT c.name_en AS country_name,
               s.sitelinks_count,
               s.population,
               s.enrichment_level
        FROM sites s
        LEFT JOIN countries c ON c.qid = s.country_qid
        WHERE s.id = ${req.params.id}
      `;

      const extra = rows[0] ?? {};

      return reply.view("admin/sites/show", {
        title: `${site.title_en} — Admin`,
        site: { ...site, ...extra },
      });
    },
  );

  // ── Timeline editing ─────────────────────────────────────────────────────
  // An entry is addressed by (track, index): the detail view renders each
  // track's entries in JSONB array order, so the index is stable within a
  // render. `expectedName` is a cheap staleness guard — if the entry at that
  // index no longer carries the name the view showed, the timeline changed
  // under us and we refuse rather than edit the wrong entry.
  const QID_TRACKS = ["polity", "culture", "religion", "language"];

  async function loadTimeline(sql: any, id: string): Promise<any | null> {
    const rows = await sql`SELECT timeline FROM sites WHERE id = ${id}`;
    if (!rows.length || rows[0].timeline == null) return null;
    const raw = rows[0].timeline;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  function entryArray(tl: any, track: string): any[] | null {
    const arr = track === "events" ? tl?.events : tl?.[track]?.entries;
    return Array.isArray(arr) ? arr : null;
  }

  function entryName(entry: any, track: string): string | null {
    if (track === "events") return entry?.type ?? null;
    const v = entry?.value;
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object") return v.name ?? v.text ?? null;
    return String(v);
  }

  // POST /admin/sites/:id/timeline/delete-entry  { track, index, expectedName? }
  app.post<{
    Params: { id: string };
    Body: { track?: string; index?: number; expectedName?: string };
  }>("/admin/sites/:id/timeline/delete-entry", async (req, reply) => {
    const sql = getSql();
    const { track, index, expectedName } = req.body ?? {};
    if (typeof track !== "string" || typeof index !== "number")
      return reply.status(400).send({ error: "track and index are required" });

    const tl = await loadTimeline(sql, req.params.id);
    if (!tl) return reply.status(404).send({ error: "No timeline" });

    const arr = entryArray(tl, track);
    if (!arr || index < 0 || index >= arr.length)
      return reply.status(400).send({ error: "Entry not found at that index" });
    if (expectedName != null && entryName(arr[index], track) !== expectedName)
      return reply
        .status(409)
        .send({ error: "Timeline changed; refresh and retry" });

    arr.splice(index, 1);
    await sql`UPDATE sites SET timeline = ${sql.json(tl)}, last_updated = now() WHERE id = ${req.params.id}`;
    return reply.send({ ok: true, track, index });
  });

  // POST /admin/sites/:id/timeline/set-qid  { track, index, qid, expectedName? }
  app.post<{
    Params: { id: string };
    Body: {
      track?: string;
      index?: number;
      qid?: string;
      expectedName?: string;
    };
  }>("/admin/sites/:id/timeline/set-qid", async (req, reply) => {
    const sql = getSql();
    const { track, index, qid, expectedName } = req.body ?? {};
    if (typeof track !== "string" || typeof index !== "number")
      return reply.status(400).send({ error: "track and index are required" });
    if (!qid || !/^Q\d+$/.test(qid))
      return reply.status(400).send({ error: "A valid QID is required" });
    if (!QID_TRACKS.includes(track))
      return reply
        .status(400)
        .send({ error: `Track ${track} has no QID slot` });

    const tl = await loadTimeline(sql, req.params.id);
    if (!tl) return reply.status(404).send({ error: "No timeline" });

    const arr = entryArray(tl, track);
    if (!arr || index < 0 || index >= arr.length)
      return reply.status(400).send({ error: "Entry not found at that index" });
    const v = arr[index]?.value;
    if (!v || typeof v !== "object")
      return reply.status(400).send({ error: "Entry has no value object" });
    if (expectedName != null && (v.name ?? null) !== expectedName)
      return reply
        .status(409)
        .send({ error: "Timeline changed; refresh and retry" });

    v.wikidata = qid;
    await sql`UPDATE sites SET timeline = ${sql.json(tl)}, last_updated = now() WHERE id = ${req.params.id}`;
    return reply.send({ ok: true, track, index, qid });
  });
};
