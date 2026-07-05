// packages/server/src/agent/resolution-tools.ts
// =============================================================================
// Resolution agent — read-only tools.
//
// Design contract (see project notes):
//   - Tools return RAW FACTS. They never judge. Judgment belongs to the agent.
//   - All tools are read-only: the agent NEVER writes. Code applies verdicts.
//   - No dependency on legacy indexer.ts (being retired).
//
// Tools:
//   searchWikidataSites(query)   → multiple candidates (kills the srlimit:1 bug)
//   getWikidataEntity(qid)       → P31 / P1366 / coords / P17 / inception-dissolution
//   geoDistance(latA,lonA,latB,lonB) → pure haversine, no network
//   checkSiteExists(qid)         → reads `sites` + `site_candidates`
//   getWikipediaIntro(title)     → SECOND RESORT when structured data is silent
// =============================================================================

import { getSql } from "@strabon/db";
import { wikiFetchJson } from "./wiki-fetch.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

// All Wikimedia calls go through the shared utility (global spacing + retry).
const fetchJson = wikiFetchJson;

// ── Tool 1: searchWikidataSites ───────────────────────────────────────────────

export type SiteCandidateResult = {
  qid: string;
  label: string;
  description: string | null;
  types: { qid: string; label: string }[]; // P31, resolved to labels
};

/**
 * Search Wikidata entities by name. Returns SEVERAL candidates with their
 * descriptions and P31 types, so the agent can disambiguate (e.g. the two
 * "Hacılar": the Neolithic tell vs the Hekimhan village).
 *
 * @param language  search/label language ("en" or "fr"). Discovery searches
 *                  both and merges, so a French place name ("Beyrouth") still
 *                  resolves to its entity (Beirut).
 *
 * Two HTTP calls: wbsearchentities (candidates) + wbgetentities (P31 + labels).
 */
export async function searchWikidataSites(
  query: string,
  limit = 10,
  language = "en",
): Promise<SiteCandidateResult[]> {
  const searchUrl =
    `${WIKIDATA_API}?action=wbsearchentities&format=json&language=${language}&uselang=${language}` +
    `&type=item&limit=${Math.min(limit, 20)}&search=${encodeURIComponent(query)}`;
  const search = await fetchJson(searchUrl);
  const hits: { id: string; label?: string; description?: string }[] =
    search.search ?? [];
  if (hits.length === 0) return [];

  // Fetch P31 claims for all hits in one call.
  const ids = hits.map((h) => h.id).join("|");
  const entUrl =
    `${WIKIDATA_API}?action=wbgetentities&format=json&props=claims&ids=${ids}`;
  const ent = await fetchJson(entUrl);

  // Collect every P31 target QID to resolve their labels in one more call.
  const typeQids = new Set<string>();
  const p31ByHit = new Map<string, string[]>();
  for (const h of hits) {
    const claims = ent.entities?.[h.id]?.claims?.P31 ?? [];
    const qids = claims
      .map((c: any) => c.mainsnak?.datavalue?.value?.id)
      .filter(Boolean);
    p31ByHit.set(h.id, qids);
    qids.forEach((q: string) => typeQids.add(q));
  }

  const typeLabels = new Map<string, string>();
  if (typeQids.size > 0) {
    const labelUrl =
      `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels` +
      `&languages=en&ids=${[...typeQids].slice(0, 50).join("|")}`;
    const lab = await fetchJson(labelUrl);
    for (const [qid, e] of Object.entries<any>(lab.entities ?? {})) {
      typeLabels.set(qid, e.labels?.en?.value ?? qid);
    }
  }

  return hits.map((h) => ({
    qid: h.id,
    label: h.label ?? h.id,
    description: h.description ?? null,
    types: (p31ByHit.get(h.id) ?? []).map((q) => ({
      qid: q,
      label: typeLabels.get(q) ?? q,
    })),
  }));
}

// ── Tool 2: getWikidataEntity ─────────────────────────────────────────────────

export type EntityDetail = {
  qid: string;
  label: string | null;
  description: string | null;
  types: { qid: string; label: string }[];        // P31
  replaced_by: { qid: string; label: string }[];  // P1366
  replaces: { qid: string; label: string }[];     // P1365
  country: { qid: string; label: string } | null; // P17
  coordinates: { lat: number; lon: number } | null; // P625
  inception_year: number | null;    // P571
  dissolution_year: number | null;  // P576
  wikipedia_en_title: string | null;
};

function claimQids(claims: any, prop: string): string[] {
  return (claims?.[prop] ?? [])
    .map((c: any) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function claimYear(claims: any, prop: string): number | null {
  const t = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value?.time;
  if (!t) return null;
  // Wikidata time format: "+1858-01-01T00:00:00Z" or "-0146-01-01..."
  const m = /^([+-])(\d{1,6})/.exec(t);
  if (!m) return null;
  const year = parseInt(m[2], 10);
  return m[1] === "-" ? -year : year;
}

/**
 * Full detail of one entity: types, succession chain (P1366/P1365),
 * coordinates, country, inception/dissolution. The raw material for the
 * ancient/modern judgment.
 */
export async function getWikidataEntity(qid: string): Promise<EntityDetail> {
  const url =
    `${WIKIDATA_API}?action=wbgetentities&format=json` +
    `&props=labels|descriptions|claims|sitelinks&languages=en&ids=${qid}`;
  const data = await fetchJson(url);
  const e = data.entities?.[qid];
  if (!e || e.missing !== undefined) {
    throw new Error(`Entity ${qid} not found on Wikidata`);
  }

  const claims = e.claims ?? {};
  const typeQids = claimQids(claims, "P31");
  const replacedByQids = claimQids(claims, "P1366");
  const replacesQids = claimQids(claims, "P1365");
  const countryQid = claimQids(claims, "P17")[0] ?? null;

  // Resolve labels of every referenced QID in one call.
  const refQids = [
    ...new Set([...typeQids, ...replacedByQids, ...replacesQids,
                ...(countryQid ? [countryQid] : [])]),
  ];
  const labels = new Map<string, string>();
  if (refQids.length > 0) {
    const labUrl =
      `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels` +
      `&languages=en&ids=${refQids.slice(0, 50).join("|")}`;
    const lab = await fetchJson(labUrl);
    for (const [q, ent] of Object.entries<any>(lab.entities ?? {})) {
      labels.set(q, ent.labels?.en?.value ?? q);
    }
  }
  const withLabel = (q: string) => ({ qid: q, label: labels.get(q) ?? q });

  const coordVal = claims?.P625?.[0]?.mainsnak?.datavalue?.value;

  return {
    qid,
    label: e.labels?.en?.value ?? null,
    description: e.descriptions?.en?.value ?? null,
    types: typeQids.map(withLabel),
    replaced_by: replacedByQids.map(withLabel),
    replaces: replacesQids.map(withLabel),
    country: countryQid ? withLabel(countryQid) : null,
    coordinates: coordVal
      ? { lat: coordVal.latitude, lon: coordVal.longitude }
      : null,
    inception_year: claimYear(claims, "P571"),
    dissolution_year: claimYear(claims, "P576"),
    wikipedia_en_title: e.sitelinks?.enwiki?.title ?? null,
  };
}

// ── Tool 3: geoDistance ───────────────────────────────────────────────────────

/**
 * Haversine distance in kilometres. Pure calculation, no network.
 * The agent already holds coordinates from getWikidataEntity.
 */
export function geoDistance(
  latA: number, lonA: number, latB: number, lonB: number,
): { km: number } {
  const R = 6371;
  const dLat = ((latB - latA) * Math.PI) / 180;
  const dLon = ((lonB - lonA) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((latA * Math.PI) / 180) *
      Math.cos((latB * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return { km: Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10 };
}

// ── Tool 4: checkSiteExists ───────────────────────────────────────────────────

export type SiteExistence = {
  in_sites: { id: string; title_en: string } | null;
  in_candidates: { id: number; raw_title: string; status: string } | null;
};

/**
 * Reliable dedup: is this QID already known — as a production site, or as a
 * candidate elsewhere in the pipeline?
 */
export async function checkSiteExists(qid: string): Promise<SiteExistence> {
  const sql = getSql();
  const sites = await sql`
    SELECT id, title_en FROM sites
    WHERE wikidata_id = ${qid} OR id = ${qid}
    LIMIT 1
  `;
  const candidates = await sql`
    SELECT id, raw_title, status FROM site_candidates
    WHERE wikidata_id = ${qid}
    LIMIT 1
  `;
  return {
    in_sites: sites.length
      ? { id: sites[0].id, title_en: sites[0].title_en }
      : null,
    in_candidates: candidates.length
      ? {
          id: Number(candidates[0].id),
          raw_title: candidates[0].raw_title,
          status: candidates[0].status,
        }
      : null,
  };
}

// ── Tool 5: getWikipediaIntro ─────────────────────────────────────────────────

/**
 * Plain-text intro of an English Wikipedia page. SECOND RESORT: the agent
 * should only reach for this when the ancient/modern relation is absent from
 * structured Wikidata (no P1366/P1365) but likely stated in prose
 * ("X is the ancient name of Y").
 */
export async function getWikipediaIntro(
  title: string,
): Promise<{ title: string; intro: string | null }> {
  const url =
    `${WIKIPEDIA_API}?action=query&format=json&prop=extracts&exintro=1` +
    `&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`;
  const data = await fetchJson(url);
  const pages = data.query?.pages ?? {};
  const page: any = Object.values(pages)[0];
  if (!page || page.missing !== undefined) {
    return { title, intro: null };
  }
  const intro: string = page.extract ?? "";
  // Cap the intro: the agent needs the opening statements, not an essay.
  return {
    title: page.title ?? title,
    intro: intro.length > 1500 ? intro.slice(0, 1500) + " […]" : intro || null,
  };
}
