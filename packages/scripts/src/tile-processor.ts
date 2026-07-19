// packages/server/src/agent/tile-processor.ts
// =============================================================================
// Tile processor — deterministic indexation of a 1° tile via Wikidata SPARQL.
//
// No LLM involved. The SPARQL query enumerates all inhabited/historical places
// in the tile's bounding box, filtered by the `place_classes` whitelist. Each
// result is written into `sites` at enrichment_level='indexed' (L0) with its
// priority signals (sitelinks_count, population). The tile is marked done.
//
// Uses wiki-fetch for polite Wikimedia access (spacing + retry).
// =============================================================================

import { getSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// ── Curated class filter ──────────────────────────────────────────────────────
// The allowed P31 classes now come from `place_classes` (built by
// build-place-classes.ts from live Wikidata closures — see
// migration-place-classes.sql for the full rationale) instead of a hardcoded
// 6-root list with runtime P279*. Two problems this fixes:
//   1. Recall: classes like "commune of France" don't chain via P279* to any
//      of the old 6 roots, so ~46k French communes were invisible. The new
//      whitelist is a flat, pre-computed closure — no runtime traversal gaps.
//   2. Precision: "archaeological site" used to pull its FULL closure (585
//      heterogeneous classes: dolmens, isolated Roman temples, production
//      sites...). place_classes keeps only a curated habitation-pattern
//      subset of it.
//
// Loaded once per process and cached (queried thousands of times in batch
// mode — see batch-tiles.ts).

let cachedClassQids: string[] | null = null;

async function loadPlaceClasses(): Promise<string[]> {
  if (cachedClassQids) return cachedClassQids;
  const sql = getSql();
  const rows = await sql`SELECT qid FROM place_classes`;
  if (rows.length === 0) {
    throw new Error(
      "place_classes table is empty — run `npx -y tsx packages/scripts/src/build-place-classes.ts` first.",
    );
  }
  cachedClassQids = rows.map((r: any) => r.qid);
  return cachedClassQids;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type TileSite = {
  qid: string;
  label: string;
  description: string | null;
  type: string | null;      // P31 type label (human-readable, for meta)
  type_qid: string | null;  // P31 type QID (queryable — was previously discarded)
  lat: number;
  lon: number;
  country_qid: string | null;
  sitelinks_count: number | null;
  population: number | null;
  inception_year: number | null;      // P571, historical year (BC negative)
  wikipedia_page_en_url: string | null; // enwiki article, ~68% coverage, free here
  already_in_db: boolean;
};

export type TileResult = {
  lon_min: number;
  lat_min: number;
  sites: TileSite[];
  new_count: number;         // sites not already in DB
  existing_count: number;    // sites already in DB (skipped)
  total_from_sparql: number; // before dedup
  dryRun: boolean;
  executed: boolean;
};

// ── Wikidata time value parsing ───────────────────────────────────────────────
// Kept in sync with parseWikidataYear in scripts/entity-bounds-sparql.ts — same
// convention MUST be used everywhere or BC dates diverge by one year between the
// L0 index and the entity bounds. Wikidata's RDF export uses ASTRONOMICAL years
// (1 BCE = year 0); our timelines use HISTORICAL years (no year 0). Values
// outside the human range (geological/cosmological precisions exist in Wikidata)
// are rejected rather than stored.

const MIN_YEAR = -200_000;
const MAX_YEAR = 2_100;

function parseWikidataYear(value: string): number | null {
  const m = /^([+-]?)(\d+)-/.exec(value);
  if (!m) return null;
  const year = parseInt(m[2], 10);
  if (Number.isNaN(year)) return null;
  const signed = m[1] === "-" ? -year : year;
  if (signed < MIN_YEAR || signed > MAX_YEAR) return null;
  return signed <= 0 ? signed - 1 : signed;
}

// ── SPARQL query builder ──────────────────────────────────────────────────────
// IMPORTANT: `hint:Query hint:optimizer "None"` forces Wikidata to execute the
// clauses in written order — the geographic `box` FIRST (which narrows to a few
// thousand sites in the tile), THEN the class filter on that small set. Without
// this hint the query planner tries to start from the ~2100-term class list and
// the query times out (HTTP 504 at 65s, measured). We also use FILTER(?type IN
// (...)) rather than VALUES ?type {...}: with the box-first hint both work, but
// FILTER composes more predictably here. Measured with the hint: Paris tile
// 2.9s / 1226 sites (previously a 504 for both this and the old 6-root query).

function buildSparqlQuery(lonMin: number, latMin: number, classQids: string[]): string {
  const inList = classQids.map((q) => `wd:${q}`).join(", ");
  return `
SELECT DISTINCT
  ?site
  ?siteLabel
  ?d
  ?type
  ?typeLabel
  ?coord
  ?country
  ?sl
  ?pop
  ?inception
  ?enwiki
WHERE {
  hint:Query hint:optimizer "None" .
  SERVICE wikibase:box {
    ?site wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${lonMin} ${latMin})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${lonMin + 1} ${latMin + 1})"^^geo:wktLiteral .
  }
  ?site wdt:P31 ?type .
  FILTER(?type IN (${inList}))
  OPTIONAL { ?site schema:description ?d . FILTER(LANG(?d)="en") }
  OPTIONAL { ?site wdt:P17 ?country }
  OPTIONAL { ?site wikibase:sitelinks ?sl }
  OPTIONAL { ?site wdt:P1082 ?pop }
  OPTIONAL { ?site wdt:P571 ?inception }
  OPTIONAL { ?enwiki schema:about ?site ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;
}

// ── SPARQL execution ──────────────────────────────────────────────────────────
// POST (not GET): the VALUES clause carries ~2000+ QIDs from place_classes,
// which comfortably exceeds URL length limits on GET.

async function executeSparql(query: string): Promise<any[]> {
  const data = await wikiFetchJson(`${SPARQL_ENDPOINT}?format=json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `query=${encodeURIComponent(query)}`,
  });
  return data?.results?.bindings ?? [];
}

// ── Parse SPARQL bindings into TileSite, dedup by QID ─────────────────────────

function parseResults(bindings: any[]): Omit<TileSite, "already_in_db">[] {
  const byQid = new Map<string, Omit<TileSite, "already_in_db">>();

  for (const b of bindings) {
    const siteUri: string = b.site?.value ?? "";
    const qid = siteUri.split("/").pop() ?? "";
    if (!qid.startsWith("Q")) continue;

    // Keep first occurrence per QID (dedup).
    if (byQid.has(qid)) continue;

    // Parse coordinates from "Point(lon lat)" WKT.
    let lat = 0, lon = 0;
    const coordStr: string = b.coord?.value ?? "";
    const m = /Point\(([^ ]+) ([^ ]+)\)/.exec(coordStr);
    if (m) { lon = parseFloat(m[1]); lat = parseFloat(m[2]); }

    // Sitelinks count and population: take the numeric value if present.
    const sl = b.sl?.value != null ? parseInt(b.sl.value, 10) : null;
    const pop = b.pop?.value != null ? parseInt(b.pop.value, 10) : null;

    byQid.set(qid, {
      qid,
      label: b.siteLabel?.value ?? qid,
      description: b.d?.value ?? null,
      type: b.typeLabel?.value ?? null,
      type_qid: (b.type?.value ?? "").split("/").pop() || null,
      lat,
      lon,
      country_qid: b.country?.value?.split("/").pop() ?? null,
      sitelinks_count: isNaN(sl as number) ? null : sl,
      population: isNaN(pop as number) ? null : pop,
      inception_year: b.inception?.value ? parseWikidataYear(b.inception.value) : null,
      wikipedia_page_en_url: b.enwiki?.value ?? null,
    });
  }

  return [...byQid.values()];
}

// ── Main: process one tile ────────────────────────────────────────────────────

export async function processTile(
  lonMin: number,
  latMin: number,
  opts: { dryRun?: boolean; verbose?: boolean } = {},
): Promise<TileResult> {
  const dryRun = opts.dryRun ?? false;
  const verbose = opts.verbose ?? true;
  const log = (m: string) => verbose && console.log(`[tile ${lonMin},${latMin}] ${m}`);
  const sql = getSql();

  // 1. Build and execute SPARQL.
  const classQids = await loadPlaceClasses();
  log(`querying SPARQL (${classQids.length} allowed classes)...`);
  const query = buildSparqlQuery(lonMin, latMin, classQids);
  const bindings = await executeSparql(query);
  log(`${bindings.length} raw bindings`);

  // 2. Parse and dedup.
  const parsed = parseResults(bindings);
  log(`${parsed.length} distinct sites after dedup`);

  // 3. Check which are already in DB.
  const sites: TileSite[] = [];
  let newCount = 0;
  let existingCount = 0;
  for (const s of parsed) {
    const existing = await sql`
      SELECT id FROM sites WHERE id = ${s.qid} OR wikidata_id = ${s.qid} LIMIT 1
    `;
    const already = existing.length > 0;
    sites.push({ ...s, already_in_db: already });
    if (already) existingCount++; else newCount++;
  }
  log(`${newCount} new, ${existingCount} already in DB`);

  const result: TileResult = {
    lon_min: lonMin,
    lat_min: latMin,
    sites,
    new_count: newCount,
    existing_count: existingCount,
    total_from_sparql: bindings.length,
    dryRun,
    executed: false,
  };

  if (dryRun) return result;

  // 4. Write new sites to DB as L0 (indexed).
  for (const s of sites) {
    if (s.already_in_db) continue;
    await sql`
      INSERT INTO sites (
        id, wikidata_id, title_en, location,
        enrichment_level, sitelinks_count, population,
        country_qid, inception_year, wikipedia_page_en_url, meta
      ) VALUES (
        ${s.qid},
        ${s.qid},
        ${s.label},
        ST_SetSRID(ST_MakePoint(${s.lon}, ${s.lat}), 4326),
        'indexed',
        ${s.sitelinks_count},
        ${s.population},
        ${s.country_qid},
        ${s.inception_year},
        ${s.wikipedia_page_en_url},
        ${JSON.stringify({
          wikidata_description: s.description,
          wikidata_type: s.type,
          wikidata_type_qid: s.type_qid,
          indexed_from_tile: `${lonMin},${latMin}`,
        })}
      )
      ON CONFLICT (id) DO UPDATE SET
        sitelinks_count = COALESCE(EXCLUDED.sitelinks_count, sites.sitelinks_count),
        population = COALESCE(EXCLUDED.population, sites.population),
        inception_year = COALESCE(sites.inception_year, EXCLUDED.inception_year),
        wikipedia_page_en_url = COALESCE(sites.wikipedia_page_en_url, EXCLUDED.wikipedia_page_en_url),
        enrichment_level = COALESCE(sites.enrichment_level, 'indexed')
    `;
  }

  // 5. Mark tile as done.
  await sql`
    UPDATE tiles SET
      status = 'done',
      site_count = ${parsed.length},
      processed_at = now(),
      sparql_class_filter = ${`place_classes (${classQids.length} classes)`}
    WHERE lon_min = ${lonMin} AND lat_min = ${latMin}
  `;

  log(`wrote ${newCount} new sites, tile marked done`);
  result.executed = true;
  return result;
}
