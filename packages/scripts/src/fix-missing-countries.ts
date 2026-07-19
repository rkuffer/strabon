// packages/scripts/src/fix-missing-countries.ts
// =============================================================================
// Resolve missing country QIDs from a file, display for review, then insert
// the ones confirmed as current countries.
//
// Usage:
//   npx tsx packages/scripts/src/fix-missing-countries.ts /tmp/missing-country-qids.txt
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";
import { readFileSync } from "fs";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// Known historical entities to SKIP (not current countries)
const SKIP_QIDS = new Set([
  "Q28513",    // Austria-Hungary
  "Q131964",   // Austrian Empire
  "Q15180",    // Soviet Union
  "Q193714",   // Mandatory Palestine
  "Q1747689",  // Ancient Rome
  "Q34266",    // Russian Empire
  "Q7318",     // Nazi Germany
  "Q12544",    // Byzantine Empire
  "Q2277",     // Roman Empire
  "Q83286",    // SFR Yugoslavia
  "Q15102440", // Kingdom of SHS
  "Q191077",   // Kingdom of Yugoslavia
  "Q13426199", // Republic of China (historical)
  "Q12560",    // Ottoman Empire
  "Q83891",    // Sasanian Empire
  "Q93180",    // Seleucid Empire
  "Q8575586",  // Umayyad Caliphate
  "Q12536",    // Abbasid Caliphate
  "Q207272",   // Second Polish Republic
  "Q174193",   // UK of GB and Ireland
]);

async function main() {
  const file = process.argv[2];
  if (!file) { console.error("Usage: fix-missing-countries.ts <qids-file>"); process.exit(1); }

  const qids = readFileSync(file, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("Q"));

  console.log(`Resolving ${qids.length} QIDs...\n`);

  const sql = getSql();
  const toInsert: { qid: string; name: string; desc: string }[] = [];
  const skipped: { qid: string; name: string; reason: string }[] = [];

  // Batch resolve (50 at a time)
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const ids = batch.join("|");
    const url = `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels|descriptions&languages=en&ids=${ids}`;
    const data = await wikiFetchJson(url);
    const entities = data?.entities ?? {};

    for (const qid of batch) {
      const e = entities[qid];
      const name = e?.labels?.en?.value ?? qid;
      const desc = e?.descriptions?.en?.value ?? "";

      if (SKIP_QIDS.has(qid)) {
        skipped.push({ qid, name, reason: "known historical entity" });
      } else if (desc.match(/historical|former|ancient|medieval|dynasty|empire|kingdom|caliphate|occupation|colony|soviet/i) && !desc.match(/^country|^sovereign|^state in/i)) {
        skipped.push({ qid, name, reason: `description: "${desc}"` });
      } else {
        toInsert.push({ qid, name, desc });
      }
    }
  }

  console.log("=== TO INSERT (current countries) ===");
  for (const c of toInsert) {
    console.log(`  ✓ ${c.qid.padEnd(12)} ${c.name.padEnd(35)} ${c.desc}`);
  }

  console.log(`\n=== SKIPPED (historical/non-country) ===`);
  for (const s of skipped) {
    console.log(`  ✗ ${s.qid.padEnd(12)} ${s.name.padEnd(35)} ${s.reason}`);
  }

  console.log(`\nInserting ${toInsert.length} countries...`);

  for (const c of toInsert) {
    await sql`
      INSERT INTO countries (qid, name_en)
      VALUES (${c.qid}, ${c.name})
      ON CONFLICT (qid) DO UPDATE SET name_en = EXCLUDED.name_en
    `;
  }

  const [stats] = await sql`SELECT COUNT(*) AS total FROM countries`;
  console.log(`Done. Total countries in table: ${stats.total}`);

  await closeSql();
}

main().catch(err => { console.error("FAILED:", err?.message ?? err); process.exit(1); });
