// packages/server/src/routes/admin/sites.ts
import type { FastifyPluginAsync } from "fastify";
import {
  getSql,
  getSiteById,
  loadEntityBounds,
  recordBoundsConflicts,
  verifyQid,
  fetchAndStoreBounds,
} from "@strabon/db";
import { applyEntityBounds } from "@strabon/shared";

const WDQS = "https://query.wikidata.org/sparql";
const WDQS_UA = "Strabon/1.0 (historical atlas; github.com/rkuffer/strabon)";

// Roots for classifying a picked Wikidata QID via P31/P279*.
// SITE is checked first and WINS: a city-state, ancient city, settlement, etc.
// is a SITE (it lives in `sites`) and must NOT be duplicated into the entity
// referential — its political role is expressed by referencing its QID on a
// polity track, nothing more. The four referential kinds mirror EXPECTED_ROOTS
// in referential-gaps.ts, plus ethnic group (Q41710) so ethnonyms classify as
// culture.
const CLASSIFY_ROOTS: Array<[string, string]> = [
  ["Q486972", "site"],
  ["Q839954", "site"],
  ["Q515", "site"],
  ["Q532", "site"],
  ["Q3957", "site"],
  ["Q15661340", "site"],
  ["Q133442", "site"],
  ["Q7275", "polity"],
  ["Q3624078", "polity"],
  ["Q6256", "polity"],
  ["Q3024240", "polity"],
  ["Q1250464", "polity"],
  ["Q48349", "polity"],
  ["Q465299", "culture"],
  ["Q11042", "culture"],
  ["Q28171", "culture"],
  ["Q41710", "culture"],
  ["Q9174", "religion"],
  ["Q179805", "religion"],
  ["Q1530022", "religion"],
  ["Q34770", "language"],
  ["Q17376908", "language"],
  ["Q436240", "language"],
];
const REF_KINDS = ["polity", "culture", "religion", "language"];

export const adminSitesRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/sites — liste avec filtres
  app.get<{
    Querystring: {
      q?: string;
      status?: "no_timeline" | "no_coords" | "extracted" | "all";
      country?: string;
      page?: string;
      sort?: "importance" | "extracted_asc" | "extracted_desc";
    };
  }>("/admin/sites", async (req, reply) => {
    const sql = getSql();
    const {
      q,
      status = "all",
      country,
      page = "1",
      sort = "importance",
    } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const conditions: string[] = [];
    const qEsc = q ? q.replace(/'/g, "''") : "";
    if (q) conditions.push(`s.title_en ILIKE '%${qEsc}%'`);
    if (status === "no_timeline") conditions.push(`s.timeline IS NULL`);
    if (status === "no_coords") conditions.push(`s.location IS NULL`);
    if (status === "extracted")
      conditions.push(`s.enrichment_level = 'extracted'`);
    if (country)
      conditions.push(`s.country_qid = '${country.replace(/'/g, "''")}'`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Clef de tri principale. `extracted_asc` (extraction la plus ANCIENNE
    // d'abord) est le tri de ré-extraction : le pipeline a évolué depuis les
    // premières extractions, on veut retrouver les timelines les plus vieilles
    // pour les reconstruire. NULLS LAST garde les sites jamais extraits en fin
    // de liste plutôt que de les mêler aux dates.
    const sortClause =
      sort === "extracted_asc"
        ? `s.timeline_extracted_at ASC NULLS LAST, s.title_en`
        : sort === "extracted_desc"
          ? `s.timeline_extracted_at DESC NULLS LAST, s.title_en`
          : `s.base_importance DESC NULLS LAST, s.title_en`;

    // Avec une recherche texte : correspondance exacte du titre d'abord, puis
    // les titres qui commencent par la requête, puis le reste — la clef de tri
    // choisie sert de tie-break. Sans recherche : tri choisi directement.
    // (même logique de pertinence que /admin/curation)
    const orderBy = q
      ? `CASE
           WHEN lower(s.title_en) = lower('${qEsc}') THEN 0
           WHEN s.title_en ILIKE '${qEsc}%' THEN 1
           ELSE 2
         END,
         ${sortClause}`
      : sortClause;

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
      sort,
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

  // Recompute this site's bound conflicts after a manual edit and rewrite its
  // bounds_conflicts rows — otherwise /admin/bounds keeps showing a conflict the
  // curator has just fixed here (that table is only otherwise refreshed at
  // extraction / bounds-sync time). recordBoundsConflicts deletes the site's rows
  // and re-inserts only the ones that still hold, so a corrected/deleted/reassigned
  // entry drops out. Conflicts-only: we deliberately do NOT write back the cuts
  // applyEntityBounds would apply, to avoid silently re-trimming a date the curator
  // just set. Non-fatal — the edit itself already succeeded.
  async function refreshBoundsConflicts(
    siteId: string,
    tl: any,
  ): Promise<void> {
    try {
      const bounds = await loadEntityBounds();
      const { conflicts } = applyEntityBounds(tl, bounds);
      await recordBoundsConflicts(siteId, conflicts);
    } catch (err) {
      app.log.warn({ err, siteId }, "refreshBoundsConflicts failed");
    }
  }

  // GET /admin/sites/classify-qid?qid=Q… — used by the entry modal when the
  // curator picks a Wikidata QID, to decide whether it may enter the referential.
  // Returns whether the QID is already in our referential, whether Wikidata
  // classes it as a SITE (→ do NOT add), and the detected referential kind.
  app.get<{ Querystring: { qid?: string } }>(
    "/admin/sites/classify-qid",
    async (req, reply) => {
      const qid = req.query.qid;
      if (!qid || !/^Q\d+$/.test(qid))
        return reply.status(400).send({ error: "qid required" });

      const sql = getSql();
      const known = await sql`
        SELECT kind FROM wikidata_entities WHERE qid = ${qid}
      `;
      if (known.length)
        return reply.send({
          inReferential: true,
          existingKind: (known[0] as any).kind,
          isSite: false,
          kind: null,
        });

      const values = CLASSIFY_ROOTS.map(([r, k]) => `(wd:${r} "${k}")`).join(
        " ",
      );
      const query = `SELECT DISTINCT ?kind WHERE { VALUES (?root ?kind) { ${values} } wd:${qid} wdt:P31/wdt:P279* ?root . }`;
      try {
        const res = await fetch(WDQS, {
          method: "POST",
          headers: {
            "Content-Type": "application/sparql-query",
            Accept: "application/sparql-results+json",
            "User-Agent": WDQS_UA,
          },
          body: query,
        });
        if (!res.ok)
          return reply.send({
            inReferential: false,
            isSite: false,
            kind: null,
            ok: false,
          });
        const json: any = await res.json();
        const kinds = new Set<string>(
          (json.results?.bindings ?? [])
            .map((b: any) => b.kind?.value)
            .filter(Boolean),
        );
        const isSite = kinds.has("site");
        const refFound = REF_KINDS.filter((k) => kinds.has(k));
        // A single unambiguous referential kind is offered as the default.
        const kind = refFound.length === 1 ? refFound[0] : null;
        return reply.send({ inReferential: false, isSite, kind, refFound });
      } catch (err) {
        app.log.warn({ err, qid }, "classify-qid failed");
        return reply.send({
          inReferential: false,
          isSite: false,
          kind: null,
          ok: false,
        });
      }
    },
  );

  // Ingest a picked Wikidata QID into the referential (verified) and fetch its
  // bounds — mirrors the /admin/gaps resolution path. No-op if it already exists.
  async function ensureEntityIngested(
    sql: any,
    qid: string,
    kind: string,
    name: string,
  ): Promise<void> {
    if (!REF_KINDS.includes(kind)) return; // guard: only the 4 referential kinds
    const exists =
      await sql`SELECT 1 FROM wikidata_entities WHERE qid = ${qid}`;
    if (exists.length) return;
    const verified = await verifyQid(qid, kind, name);
    await sql`
      INSERT INTO wikidata_entities
        (qid, kind, label_en, description_en, search_text, family_label, source_class)
      VALUES (
        ${qid}, ${kind}, ${verified.label ?? name},
        ${verified.description ?? null}, ${name}, NULL, 'site-editor'
      )
      ON CONFLICT (qid) DO NOTHING
    `;
    await fetchAndStoreBounds(sql, [qid]); // dates via SPARQL, with precision
  }

  function entryName(entry: any, track: string): string | null {
    if (track === "events") return entry?.type ?? null;
    const v = entry?.value;
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object") return v.name ?? v.text ?? null;
    return String(v);
  }

  const ROLES = ["state", "major", "minor", "minority"];
  const PRECISIONS = [6, 7, 8, 9];

  // Apply optional date/role fields onto an entry (mutates). Returns an error
  // string or null. Precision 9 (year) and circa=false are stored as ABSENCE to
  // match the extraction convention; `to`=null/"" deletes the bound; role only
  // applies to the co-occurrent tracks.
  function applyDatesAndRole(
    entry: any,
    body: any,
    track: string,
  ): string | null {
    if (body.from !== undefined) {
      if (typeof body.from !== "number" || !Number.isFinite(body.from))
        return "from must be a number";
      entry.from = Math.trunc(body.from);
    }
    if (body.from_precision !== undefined) {
      if (body.from_precision === null || body.from_precision === 9)
        delete entry.from_precision;
      else if (PRECISIONS.includes(body.from_precision))
        entry.from_precision = body.from_precision;
      else return "invalid from_precision";
    }
    if (body.from_circa !== undefined) {
      if (body.from_circa) entry.from_circa = true;
      else delete entry.from_circa;
    }
    if (body.to !== undefined) {
      if (body.to === null || body.to === "") delete entry.to;
      else if (typeof body.to === "number" && Number.isFinite(body.to))
        entry.to = Math.trunc(body.to);
      else return "to must be a number or null";
    }
    if (
      body.role !== undefined &&
      (track === "religion" || track === "language")
    ) {
      if (!body.role) delete entry.role;
      else if (ROLES.includes(body.role)) entry.role = body.role;
      else return "invalid role";
    }
    return null;
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
    await refreshBoundsConflicts(req.params.id, tl);
    return reply.send({ ok: true, track, index });
  });

  // POST /admin/sites/:id/timeline/set-qid
  //   { track, index, qid?, newName?, notes?, from?, from_precision?, from_circa?,
  //     to?, role?, expectedName? }
  // Edits a referential-track entry: (re)assign the QID and/or amend the label,
  // note, dates (from + precision + circa, to) and role. Every field is optional
  // so a curator can fix just the dates, or just the note, without re-picking a QID.
  app.post<{
    Params: { id: string };
    Body: {
      track?: string;
      index?: number;
      qid?: string;
      expectedName?: string;
      newName?: string;
      notes?: string;
      from?: number;
      from_precision?: number | null;
      from_circa?: boolean;
      to?: number | null;
      role?: string;
      ingest?: boolean;
      kind?: string;
    };
  }>("/admin/sites/:id/timeline/set-qid", async (req, reply) => {
    const sql = getSql();
    const { track, index, qid, expectedName, newName, notes } = req.body ?? {};
    if (typeof track !== "string" || typeof index !== "number")
      return reply.status(400).send({ error: "track and index are required" });
    if (qid != null && qid !== "" && !/^Q\d+$/.test(qid))
      return reply.status(400).send({ error: "Invalid QID" });
    if (!QID_TRACKS.includes(track))
      return reply
        .status(400)
        .send({ error: `Track ${track} has no QID slot` });

    const tl = await loadTimeline(sql, req.params.id);
    if (!tl) return reply.status(404).send({ error: "No timeline" });

    const arr = entryArray(tl, track);
    if (!arr || index < 0 || index >= arr.length)
      return reply.status(400).send({ error: "Entry not found at that index" });
    const entry = arr[index];

    // Accept both value shapes: the canonical {name, wikidata?} AND the legacy
    // one where value is a bare string with wikidata as a SIBLING field (some
    // older culture/polity extractions). Editing canonicalises to {name,
    // wikidata?} and drops the sibling.
    let curName: string | null;
    let curQid: string | undefined;
    if (entry?.value && typeof entry.value === "object") {
      curName = entry.value.name ?? null;
      curQid = entry.value.wikidata;
    } else if (typeof entry?.value === "string") {
      curName = entry.value;
      curQid = typeof entry.wikidata === "string" ? entry.wikidata : undefined;
    } else {
      return reply.status(400).send({ error: "Entry has no value" });
    }
    if (expectedName != null && curName !== expectedName)
      return reply
        .status(409)
        .send({ error: "Timeline changed; refresh and retry" });

    const finalName =
      typeof newName === "string" && newName.trim()
        ? newName.trim().slice(0, 200)
        : (curName ?? "");
    const finalQid = qid || curQid;
    entry.value = finalQid
      ? { name: finalName, wikidata: finalQid }
      : { name: finalName };
    if ("wikidata" in entry) delete entry.wikidata; // drop legacy sibling

    if (typeof notes === "string") {
      const t = notes.trim().slice(0, 2000);
      if (t) entry.notes = t;
      else delete entry.notes;
    }
    const drErr = applyDatesAndRole(entry, req.body ?? {}, track);
    if (drErr) return reply.status(400).send({ error: drErr });

    await sql`UPDATE sites SET timeline = ${sql.json(tl)}, last_updated = now() WHERE id = ${req.params.id}`;
    if (req.body?.ingest && finalQid) {
      const k = REF_KINDS.includes(req.body?.kind ?? "")
        ? (req.body!.kind as string)
        : track;
      await ensureEntityIngested(sql, finalQid, k, finalName);
    }
    await refreshBoundsConflicts(req.params.id, tl);
    return reply.send({
      ok: true,
      track,
      index,
      qid: entry.value.wikidata ?? null,
      name: entry.value.name,
      notes: entry.notes ?? null,
    });
  });

  // POST /admin/sites/:id/timeline/add-entry
  //   { track, name, qid?, from, from_precision?, from_circa?, to?, role?, notes? }
  // Adds a NEW entry to a referential track, inserted chronologically. For the
  // Jerusalem case: intercalating a hand-built culture sequence (Levantine
  // Chalcolithic → Early/Middle/Late Bronze Age → Israelites …).
  app.post<{
    Params: { id: string };
    Body: {
      track?: string;
      name?: string;
      qid?: string;
      from?: number;
      from_precision?: number | null;
      from_circa?: boolean;
      to?: number | null;
      role?: string;
      notes?: string;
      ingest?: boolean;
      kind?: string;
    };
  }>("/admin/sites/:id/timeline/add-entry", async (req, reply) => {
    const sql = getSql();
    const body = req.body ?? {};
    const track = body.track;
    if (typeof track !== "string" || !QID_TRACKS.includes(track))
      return reply
        .status(400)
        .send({ error: "A referential track is required" });
    const name = (body.name ?? "").trim();
    if (!name) return reply.status(400).send({ error: "A label is required" });
    if (typeof body.from !== "number" || !Number.isFinite(body.from))
      return reply.status(400).send({ error: "from (year) is required" });
    if (body.qid != null && body.qid !== "" && !/^Q\d+$/.test(body.qid))
      return reply.status(400).send({ error: "Invalid QID" });

    const tl = await loadTimeline(sql, req.params.id);
    if (!tl) return reply.status(404).send({ error: "No timeline" });
    if (!tl[track] || !Array.isArray(tl[track].entries))
      tl[track] = { entries: [] };

    const entry: any = {
      from: Math.trunc(body.from),
      value: { name: name.slice(0, 200) },
    };
    if (body.qid) entry.value.wikidata = body.qid;
    if (typeof body.notes === "string" && body.notes.trim())
      entry.notes = body.notes.trim().slice(0, 2000);
    const drErr = applyDatesAndRole(entry, body, track);
    if (drErr) return reply.status(400).send({ error: drErr });

    tl[track].entries.push(entry);
    tl[track].entries.sort((a: any, b: any) => (a.from ?? 0) - (b.from ?? 0));

    await sql`UPDATE sites SET timeline = ${sql.json(tl)}, last_updated = now() WHERE id = ${req.params.id}`;
    if (body.ingest && body.qid) {
      const k = REF_KINDS.includes(body.kind ?? "")
        ? (body.kind as string)
        : track;
      await ensureEntityIngested(sql, body.qid, k, name);
    }
    await refreshBoundsConflicts(req.params.id, tl);
    return reply.send({ ok: true, track, name, from: entry.from });
  });
};
