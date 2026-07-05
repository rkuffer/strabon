// packages/server/src/agent/tile-processor.ts
// =============================================================================
// Tile processor — deterministic indexation of a 1° tile via Wikidata SPARQL.
//
// No LLM involved. The SPARQL query enumerates all inhabited/historical places
// in the tile's bounding box, filtered by a curated set of place classes. Each
// result is written into `sites` at enrichment_level='indexed' (L0) with its
// priority signals (sitelinks_count, population). The tile is marked done.
//
// Uses wiki-fetch for polite Wikimedia access (spacing + retry).
// =============================================================================

import { getSql } from "@strabon/db";
import { wikiFetchJson } from "./wiki-fetch.js";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// ── Curated class filter ──────────────────────────────────────────────────────
// These root classes capture inhabited/historical places for the atlas.
// The SPARQL uses P31/P279* (instance-of / subclass-of transitive) so
// subclasses are included automatically.
// NOTE: QIDs are from memory and SHOULD BE VERIFIED against Wikidata.

const PLACE_CLASSES = [
  "wd:Q839954",    // archaeological site
  "wd:Q486972",    // human settlement
  "wd:Q515",       // city
  "wd:Q532",       // village
  "wd:Q3957",      // town
  "wd:Q15661340",  // ancient city
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type TileSite = {
  qid: string;
  label: string;
  description: string | null;
  type: string | null;
  lat: number;
  lon: number;
  country_qid: string | null;
  sitelinks_count: number | null;
  population: number | null;
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

// ── SPARQL query builder ──────────────────────────────────────────────────────

function buildSparqlQuery(lonMin: number, latMin: number): string {
  const classValues = PLACE_CLASSES.join(" ");
  return `
SELECT DISTINCT
  ?site
  ?siteLabel
  ?d
  ?typeLabel
  ?coord
  ?countryQid
  ?sl
  ?pop
WHERE {
  SERVICE wikibase:box {
    ?site wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${lonMin} ${latMin})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${lonMin + 1} ${latMin + 1})"^^geo:wktLiteral .
  }
  ?site wdt:P31 ?type .
  ?type wdt:P279* ?rootType .
  VALUES ?rootType { ${classValues} }
  OPTIONAL { ?site schema:description ?d . FILTER(LANG(?d)="en") }
  OPTIONAL { ?site wdt:P17 ?country . BIND(REPLACE(STR(?country), ".*/(Q\\\\d+)$", "$1") AS ?countryQid) }
  OPTIONAL { ?site wikibase:sitelinks ?sl }
  OPTIONAL { ?site wdt:P1082 ?pop }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;
}

// ── SPARQL execution ──────────────────────────────────────────────────────────

async function executeSparql(query: string): Promise<any[]> {
  const url =
    `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await wikiFetchJson(url);
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
      lat,
      lon,
      country_qid: b.countryQid?.value ?? null,
      sitelinks_count: isNaN(sl as number) ? null : sl,
      population: isNaN(pop as number) ? null : pop,
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
  log("querying SPARQL...");
  const query = buildSparqlQuery(lonMin, latMin);
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
        country_qid, meta
      ) VALUES (
        ${s.qid},
        ${s.qid},
        ${s.label},
        ST_SetSRID(ST_MakePoint(${s.lon}, ${s.lat}), 4326),
        'indexed',
        ${s.sitelinks_count},
        ${s.population},
        ${s.country_qid},
        ${JSON.stringify({
          wikidata_description: s.description,
          wikidata_type: s.type,
          indexed_from_tile: `${lonMin},${latMin}`,
        })}
      )
      ON CONFLICT (id) DO UPDATE SET
        sitelinks_count = COALESCE(EXCLUDED.sitelinks_count, sites.sitelinks_count),
        population = COALESCE(EXCLUDED.population, sites.population),
        enrichment_level = COALESCE(sites.enrichment_level, 'indexed')
    `;
  }

  // 5. Mark tile as done.
  await sql`
    UPDATE tiles SET
      status = 'done',
      site_count = ${parsed.length},
      processed_at = now(),
      sparql_class_filter = ${PLACE_CLASSES.join(", ")}
    WHERE lon_min = ${lonMin} AND lat_min = ${latMin}
  `;

  log(`wrote ${newCount} new sites, tile marked done`);
  result.executed = true;
  return result;
}
