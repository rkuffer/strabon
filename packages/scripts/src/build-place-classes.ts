// packages/scripts/src/build-place-classes.ts
// =============================================================================
// Build (or rebuild) the place_classes whitelist from live Wikidata.
//
// Strategy (see migration-place-classes.sql for the full rationale):
//   INCLUDE = closure(human settlement) ∪ closure(municipality) ∪ POSITIVE_LIST(archaeological site)
//   EXCLUDE = closure(camp) ∪ closure(monastery) ∪ closure(dwelling place)
//           ∪ closure(neighborhood) ∪ closure(quarter) ∪ MANUAL_EXCLUDE
//   FINAL   = (closure(human settlement) \ EXCLUDE) ∪ closure(municipality)
//           ∪ (POSITIVE_LIST(archaeological site) \ already covered)
//
// "archaeological site" (Q839954) is NOT a clean hierarchy (585 heterogeneous
// classes: funerary megaliths, isolated Roman temples, production sites,
// archaeological-method terms like "rescue excavation"...). Excluding
// sub-trees doesn't work there (no shared parent to exclude on), so instead
// of the full closure we keep a curated POSITIVE list of habitation-pattern
// classes, matched by keyword against the fetched labels. If Wikidata's
// taxonomy shifts, re-run this script and diff SETTLEMENT_KEYWORDS /
// GENERIC_ERA_KEYWORDS against the new archsite closure before trusting it.
//
// Usage:
//   DATABASE_URL=... npx -y tsx packages/scripts/src/build-place-classes.ts
//   DATABASE_URL=... npx -y tsx packages/scripts/src/build-place-classes.ts --dry-run
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "../../server/src/agent/wiki-fetch.js";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// ── Roots ──────────────────────────────────────────────────────────────────

const INCLUDE_ROOTS = {
  Q486972: "human settlement",
  Q15284: "municipality",
} as const;

const ARCHSITE_ROOT = "Q839954"; // archaeological site — positive-list only, see above

const EXCLUDE_ROOTS = {
  Q1326028: "camp",
  Q44613: "monastery",
  Q4632675: "dwelling place",
  Q123705: "neighborhood",
  Q2983893: "quarter",
} as const;

// Isolated items that escape the exclusion roots above via a different parent
// (e.g. "refugee camp" doesn't chain to Q1326028 in Wikidata's model) but were
// manually identified as out of scope during review (2026-07-15):
//   - Q64636958 school district of Oregon: admin zone, not a place
//   - all *camp* variants (refugee/IDP/nomadic/...): Rodolphe's call — camps
//     are contemporary history, low priority for a 12,000-year atlas, and the
//     project's constraint is curation cost, not indexing volume.
//   - a handful of neighborhood/quarter variants not caught by the label match.
const MANUAL_EXCLUDE: Record<string, string> = {
  Q64636958: "school district of Oregon",
  Q104857280: "hotspot camp",
  Q1154868: "displaced persons camp",
  Q11892704: "logging camp",
  Q124571059: "Palestinian refugee camp",
  Q12551453: "nomadic camp",
  Q131935877: "IDP camp",
  Q134411314: "district or neighborhood of Milano",
  Q17389992: "Campo Entrincheirado",
  Q17507358: "Syrian refugee camps",
  Q1767917: "campamento",
  Q3359974: "Sahrawi refugee camps",
  Q5154047: "quarter/commune of Cambodia",
  Q52154375: "district or neighborhood of Los Angeles",
  Q622499: "refugee camp",
  Q7396273: "Sabo Quarter",
  Q7832301: "Traditional Neighborhood Development",
  Q8027863: "witch camp",
  Q80838255: "Roman temporary camp",
  Q85740754: "town camp",
  Q968619: "Barn quarter",
};

// Positive-list keywords for archaeological site (Q839954). Substring match
// on the lowercased English label. "necropolis" is explicitly excluded first
// because "polis" as a keyword would otherwise match it (acropolis/necropolis
// false positive caught during review).
const SETTLEMENT_KEYWORDS = [
  "settlement", "city", "village", "town", "oppidum", "proto-city",
  "lost city", "destroyed city", "burh", "castro", "polis", "free city",
  "hillfort", "kastal", "talaiotic", "ancient city", "iberian settlement",
];
const GENERIC_ERA_KEYWORDS = [
  "paleolithic site", "stone age site", "medieval archaeological site",
  "multi-period archaeological site", "prehistoric archaeological site",
  "neolithic sites", "archaeological sites in", "archaeological site in",
];

// ── Wikidata fetch ───────────────────────────────────────────────────────────

type ClassRow = { qid: string; label: string };

async function fetchClosure(rootQid: string): Promise<Map<string, string>> {
  const query = `
    SELECT ?c ?cLabel WHERE {
      ?c wdt:P279* wd:${rootQid} .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr". }
    }
  `;
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const data = await wikiFetchJson(url);
  const bindings: any[] = data?.results?.bindings ?? [];
  const map = new Map<string, string>();
  for (const b of bindings) {
    const qid = (b.c?.value ?? "").split("/").pop();
    const label = b.cLabel?.value ?? "";
    if (qid && !map.has(qid)) map.set(qid, label);
  }
  return map;
}

function isArchsitePositive(label: string): boolean {
  const ll = label.toLowerCase();
  if (ll.includes("necropolis")) return false;
  return (
    SETTLEMENT_KEYWORDS.some((k) => ll.includes(k)) ||
    GENERIC_ERA_KEYWORDS.some((k) => ll.includes(k))
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log("=== build-place-classes ===");
  console.log(dryRun ? "mode: DRY-RUN (no writes)" : "mode: EXECUTE");

  // 1. Fetch include-root closures.
  const includeClosures = new Map<string, Map<string, string>>();
  for (const rootQid of Object.keys(INCLUDE_ROOTS)) {
    console.log(`fetching closure(${rootQid} ${INCLUDE_ROOTS[rootQid as keyof typeof INCLUDE_ROOTS]})...`);
    const closure = await fetchClosure(rootQid);
    console.log(`  ${closure.size} classes`);
    includeClosures.set(rootQid, closure);
  }

  // 2. Fetch exclude-root closures, union them.
  const excludeUnion = new Map<string, string>();
  for (const rootQid of Object.keys(EXCLUDE_ROOTS)) {
    console.log(`fetching closure(${rootQid} ${EXCLUDE_ROOTS[rootQid as keyof typeof EXCLUDE_ROOTS]}) [exclusion]...`);
    const closure = await fetchClosure(rootQid);
    console.log(`  ${closure.size} classes`);
    for (const [qid, label] of closure) excludeUnion.set(qid, label);
  }
  for (const [qid, label] of Object.entries(MANUAL_EXCLUDE)) {
    excludeUnion.set(qid, label);
  }
  console.log(`exclusion union: ${excludeUnion.size} classes`);

  // 3. Fetch archaeological site closure, keep only the positive-list subset.
  console.log(`fetching closure(${ARCHSITE_ROOT} archaeological site) [for positive-list filter]...`);
  const archsiteClosure = await fetchClosure(ARCHSITE_ROOT);
  console.log(`  ${archsiteClosure.size} classes (raw, before positive-list filter)`);
  const archsitePositive = new Map<string, string>();
  for (const [qid, label] of archsiteClosure) {
    if (isArchsitePositive(label)) archsitePositive.set(qid, label);
  }
  console.log(`  ${archsitePositive.size} classes kept (positive list: habitation types + generic era categories)`);

  // 4. Assemble final set: human settlement (minus exclusions) ∪ municipality (whole) ∪ archsite positive list (net-new only).
  const final = new Map<string, { label: string; root: string }>();

  const humanSettlement = includeClosures.get("Q486972")!;
  for (const [qid, label] of humanSettlement) {
    if (excludeUnion.has(qid)) continue;
    final.set(qid, { label, root: "Q486972" });
  }

  const municipality = includeClosures.get("Q15284")!;
  for (const [qid, label] of municipality) {
    if (!final.has(qid)) final.set(qid, { label, root: "Q15284" });
  }

  for (const [qid, label] of archsitePositive) {
    if (!final.has(qid)) final.set(qid, { label, root: ARCHSITE_ROOT });
  }

  console.log(`\nFINAL place_classes: ${final.size} classes`);
  const byRoot = new Map<string, number>();
  for (const { root } of final.values()) byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
  for (const [root, count] of byRoot) console.log(`  ${root}: ${count}`);

  if (dryRun) {
    console.log("\n[dry-run] not writing to DB.");
    return;
  }

  // 5. Materialize into place_classes (replace wholesale — this is a full rebuild).
  const sql = getSql();
  await sql`DELETE FROM place_classes`;
  let written = 0;
  for (const [qid, { label, root }] of final) {
    await sql`
      INSERT INTO place_classes (qid, label, root_qid, source)
      VALUES (${qid}, ${label}, ${root}, 'sparql-closure')
      ON CONFLICT (qid) DO UPDATE SET
        label = EXCLUDED.label,
        root_qid = EXCLUDED.root_qid,
        built_at = now()
    `;
    written++;
  }
  console.log(`\nwrote ${written} rows to place_classes.`);
}

main()
  .catch((err) => {
    console.error("BUILD FAILED:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSql();
  });
