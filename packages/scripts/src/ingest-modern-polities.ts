// packages/scripts/src/ingest-modern-polities.ts
// =============================================================================
// Ingest CONTEMPORARY sovereign states into wikidata_entities as kind='polity'.
//
// WHY: the polity referential was built from Q3024240 ("historical country"),
// which by construction EXCLUDES states that still exist. Every extraction of a
// modern site therefore signals its own country as a missing polity — and worse,
// the model falls back on approximations (using Q35 "Denmark" where it needs the
// 19th-century "Kingdom of Denmark").
//
// This ingests the ~200 current sovereign states so the timeline's most recent
// polity entry can always resolve cleanly.
//
// The `countries` table already holds exactly this list (QID + name), curated
// during the country-mapping work. We reuse it rather than re-querying Wikidata:
// it is the same set, already cleaned of historical entities.
//
// Usage:
//   DATABASE_URL=... npx tsx packages/scripts/src/ingest-modern-polities.ts [--execute]
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

async function main() {
  const execute = process.argv.includes("--execute");
  const sql = getSql();

  // Source of truth: the curated `countries` table.
  const countries = await sql`
    SELECT qid, name_en FROM countries ORDER BY name_en
  `;
  console.log(`${countries.length} countries in the curated table\n`);

  // Which are already in the referential as polities?
  const existing = await sql`
    SELECT qid FROM wikidata_entities WHERE kind = 'polity'
  `;
  const known = new Set(existing.map((r: any) => r.qid));

  const toIngest = countries.filter((c: any) => !known.has(c.qid));
  console.log(`${toIngest.length} to ingest (${countries.length - toIngest.length} already present)\n`);

  if (!toIngest.length) {
    await closeSql();
    return;
  }

  // Fetch descriptions from Wikidata (batched 50) so the prompt has context.
  const qids = toIngest.map((c: any) => c.qid as string);
  const descriptions = new Map<string, string>();

  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const url =
      `${WIKIDATA_API}?action=wbgetentities&format=json` +
      `&props=descriptions&languages=en&ids=${batch.join("|")}`;
    const data = await wikiFetchJson(url);
    for (const qid of batch) {
      const d = data?.entities?.[qid]?.descriptions?.en?.value;
      if (d) descriptions.set(qid, d);
    }
    console.log(`  fetched descriptions ${Math.min(i + 50, qids.length)}/${qids.length}`);
  }

  console.log();

  for (const c of toIngest) {
    const desc = descriptions.get(c.qid) ?? null;
    console.log(`  ${execute ? "✓" : "·"} ${c.qid.padEnd(10)} ${c.name_en.padEnd(32)} ${desc ?? ""}`);

    if (!execute) continue;

    await sql`
      INSERT INTO wikidata_entities
        (qid, kind, label_en, description_en, search_text, source_class)
      VALUES (
        ${c.qid},
        'polity',
        ${c.name_en},
        ${desc},
        ${c.name_en},
        'contemporary-state'
      )
      ON CONFLICT (qid) DO NOTHING
    `;
  }

  if (!execute) {
    console.log(`\n  (dry-run — re-run with --execute to ingest ${toIngest.length} polities)\n`);
  } else {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM wikidata_entities WHERE kind = 'polity'
    `;
    console.log(`\n  Ingested ${toIngest.length}. Total polities: ${count}\n`);
  }

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
