// packages/server/src/routes/admin/enrich.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql, upsertSite } from "@strabon/db";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const UA = "Strabon/1.0";
const TARGET_LANGS = ["en", "fr", "de", "es", "ar", "zh", "ru", "la", "grc", "fa", "tr", "it", "pt"];

// ── Helpers Wikidata ─────────────────────────────────────────────────────────

function parseWikidataTime(tv: any) {
  if (!tv?.time) return null;
  const match = tv.time.match(/^([+-])(\d+)/);
  if (!match) return null;
  const year = (match[1] === "-" ? -1 : 1) * parseInt(match[2], 10);
  return { year, precision: tv.precision ?? 9 };
}

function getClaimValue(claims: any, prop: string) {
  return (claims?.[prop] ?? [])
    .filter((s: any) => s.rank !== "deprecated" && s.mainsnak?.datavalue)
    .sort((a: any) => a.rank === "preferred" ? -1 : 1)[0]
    ?.mainsnak?.datavalue?.value;
}

const COUNTRY_LABELS: Record<string, string> = {
  Q17: "Japan", Q29: "Spain", Q30: "United States", Q38: "Italy",
  Q40: "Austria", Q41: "Greece", Q43: "Turkey", Q64: "Germany",
  Q79: "Egypt", Q90: "France", Q96: "Mexico", Q142: "France",
  Q145: "United Kingdom", Q148: "China", Q155: "Brazil", Q159: "Russia",
  Q183: "Germany", Q212: "Ukraine", Q668: "India", Q796: "Iraq",
  Q801: "Israel", Q804: "Jordan", Q822: "Lebanon", Q858: "Syria",
};

async function batchFetchWikidata(qids: string[]) {
  const results = new Map<string, any>();
  const BATCH = 50;
  for (let i = 0; i < qids.length; i += BATCH) {
    const batch = qids.slice(i, i + BATCH);
    const url = `${WIKIDATA_API}?${new URLSearchParams({
      action: "wbgetentities",
      ids: batch.join("|"),
      props: "labels|claims|descriptions",
      languages: TARGET_LANGS.join("|"),
      format: "json", origin: "*",
    })}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const data = await res.json();
    for (const [qid, entity] of Object.entries(data?.entities ?? {}) as any[]) {
      if (entity.missing) continue;
      const claims = entity.claims ?? {};
      const labels = entity.labels ?? {};

      const coord = getClaimValue(claims, "P625");
      const countryVal = getClaimValue(claims, "P17");
      const inception  = parseWikidataTime(getClaimValue(claims, "P571"));
      const dissolution= parseWikidataTime(getClaimValue(claims, "P576"));
      const nativeLbl  = getClaimValue(claims, "P1705");
      const siteTypeVal= getClaimValue(claims, "P31");

      const names: Record<string, string> = {};
      for (const lang of TARGET_LANGS) {
        if (labels[lang]?.value) names[lang] = labels[lang].value;
      }

      results.set(qid, {
        coordinates: coord?.globe?.endsWith("/Q2") ? { lat: coord.latitude, lon: coord.longitude } : null,
        country_qid: countryVal?.id ?? null,
        country: countryVal?.id ? (COUNTRY_LABELS[countryVal.id] ?? null) : null,
        names: Object.keys(names).length ? names : null,
        native_label: nativeLbl?.text ?? null,
        inception,
        dissolution,
        description: entity.descriptions?.en?.value ?? null,
        site_type: siteTypeVal?.id ?? null,
      });
    }
    if (i + BATCH < qids.length) await new Promise(r => setTimeout(r, 400));
  }
  return results;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const adminEnrichRoutes: FastifyPluginAsync = async (app) => {

  // GET /admin/enrich — page formulaire
  app.get("/admin/enrich", async (_req, reply) => {
    const sql = getSql();
    const stats = await sql`
      SELECT
        COUNT(*)::int                                              AS total,
        COUNT(*) FILTER (WHERE wikidata_enriched_at IS NULL)::int AS pending,
        COUNT(*) FILTER (WHERE wikidata_id IS NOT NULL AND wikidata_enriched_at IS NULL)::int AS enrichable
      FROM sites
    `;
    return reply.view("admin/enrich/form", {
      title:  "Enrichissement Wikidata — Admin",
      stats:  stats[0],
    });
  });

  // GET /admin/enrich/stream?since=... — SSE enrichissement batch
  app.get<{
    Querystring: { since?: string; limit?: string };
  }>("/admin/enrich/stream", async (req, reply) => {
    const { since, limit = "200" } = req.query;
    const sql = getSql();

    reply.raw.setHeader("Content-Type",  "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection",    "keep-alive");
    reply.raw.flushHeaders?.();

    const send = (event: string, data: object) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // Récupérer les sites à enrichir
      const sites = await sql.unsafe(`
        SELECT id, title_en, wikidata_id
        FROM sites
        WHERE wikidata_id IS NOT NULL
          ${since ? `AND (wikidata_enriched_at IS NULL OR wikidata_enriched_at < '${since}')` : "AND wikidata_enriched_at IS NULL"}
        ORDER BY base_importance DESC
        LIMIT ${parseInt(limit)}
      `);

      send("start", { total: sites.length });

      const BATCH = 50;
      let enriched = 0, errors = 0;

      for (let i = 0; i < sites.length; i += BATCH) {
        const batch = sites.slice(i, i + BATCH) as any[];
        const qids = batch.map((s: any) => s.wikidata_id);
        const enrichments = await batchFetchWikidata(qids);

        for (const site of batch) {
          const e = enrichments.get(site.wikidata_id);
          if (!e) continue;
          try {
            await sql`
              UPDATE sites SET
                location              = CASE WHEN ${e.coordinates !== null} AND location IS NULL
                                        THEN ST_SetSRID(ST_MakePoint(${e.coordinates?.lon ?? null}, ${e.coordinates?.lat ?? null}), 4326)
                                        ELSE location END,
                country               = COALESCE(country, ${e.country}),
                country_qid           = COALESCE(country_qid, ${e.country_qid}),
                names                 = CASE WHEN names = '{}'::jsonb THEN ${sql.json(e.names ?? {})} ELSE names END,
                meta                  = meta || ${sql.json({
                                          description:  e.description,
                                          native_label: e.native_label,
                                        })},
                inception_year        = COALESCE(inception_year, ${e.inception?.year ?? null}),
                dissolution_year      = COALESCE(dissolution_year, ${e.dissolution?.year ?? null}),
                site_type             = COALESCE(site_type, ${e.site_type}),
                wikidata_enriched_at  = now(),
                last_updated          = now()
              WHERE id = ${site.id}
            `;
            enriched++;
            send("enriched", { id: site.id, title: site.title_en, has_coords: !!e.coordinates });
          } catch (err: any) {
            errors++;
            send("error", { id: site.id, title: site.title_en, message: err.message });
          }
        }

        send("progress", { done: Math.min(i + BATCH, sites.length), total: sites.length });
        await new Promise(r => setTimeout(r, 300));
      }

      send("done", { enriched, errors });
    } catch (err: any) {
      send("fatal", { message: err.message });
    } finally {
      reply.raw.end();
    }
  });
};
