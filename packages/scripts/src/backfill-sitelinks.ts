// packages/scripts/src/backfill-sitelinks.ts
// =============================================================================
// Backfill sitelinks_count (and population if missing) for sites that were
// created before the tiling pipeline. Fetches from Wikidata in batches of 50.
//
// Usage:
//   DATABASE_URL=... npx tsx packages/scripts/src/backfill-sitelinks.ts
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "../../server/src/agent/wiki-fetch.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

async function main() {
  const sql = getSql();

  // Find sites missing sitelinks_count
  const sites = await sql`
    SELECT id, title_en FROM sites
    WHERE sitelinks_count IS NULL
    ORDER BY title_en
  `;

  console.log(`${sites.length} sites to backfill\n`);
  if (sites.length === 0) { await closeSql(); return; }

  const qids = sites.map((s: any) => s.id as string);
  let updated = 0;

  // Batch resolve (50 at a time)
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const ids = batch.join("|");
    const url = `${WIKIDATA_API}?action=wbgetentities&format=json&props=sitelinks|claims&ids=${ids}`;
    const data = await wikiFetchJson(url);
    const entities = data?.entities ?? {};

    for (const qid of batch) {
      const entity = entities[qid];
      if (!entity || entity.missing) continue;

      // Count sitelinks
      const slCount = entity.sitelinks ? Object.keys(entity.sitelinks).length : 0;

      // Extract population (P1082) — take the latest value
      let population: number | null = null;
      const popClaims = entity.claims?.P1082;
      if (popClaims?.length) {
        const last = popClaims[popClaims.length - 1];
        const popVal = last?.mainsnak?.datavalue?.value?.amount;
        if (popVal) population = parseInt(popVal.replace("+", ""), 10);
      }

      // Extract country (P17) if missing
      let countryQid: string | null = null;
      const countryClaims = entity.claims?.P17;
      if (countryClaims?.length) {
        const cVal = countryClaims[countryClaims.length - 1]?.mainsnak?.datavalue?.value?.id;
        if (cVal) countryQid = cVal;
      }

      await sql`
        UPDATE sites SET
          sitelinks_count = ${slCount},
          population = COALESCE(${population}, population),
          country_qid = COALESCE(${countryQid}, country_qid)
        WHERE id = ${qid}
      `;

      const site = sites.find((s: any) => s.id === qid);
      console.log(`  ✓ ${qid} ${(site?.title_en ?? "").padEnd(30)} sl:${slCount}${population ? ` pop:${population.toLocaleString()}` : ""}${countryQid ? ` country:${countryQid}` : ""}`);
      updated++;
    }

    console.log(`  ... ${Math.min(i + 50, qids.length)}/${qids.length} done`);
  }

  console.log(`\nBackfilled ${updated} sites`);
  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
