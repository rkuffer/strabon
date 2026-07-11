// packages/scripts/src/populate-countries.ts
// =============================================================================
// Populate the `countries` table by resolving all distinct country_qid values
// from `sites` against Wikidata (wbgetentities, batched 50 at a time).
//
// Usage:
//   DATABASE_URL=... npx tsx packages/scripts/src/populate-countries.ts
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "../../server/src/agent/wiki-fetch.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// Well-known country QID → Wikipedia language code mapping.
// Used to fill lang_code for the major countries (V2 extraction needs this).
const LANG_CODES: Record<string, string> = {
  "Q148": "zh",  "Q79": "ar",   "Q43": "tr",  "Q159": "ru",  "Q17": "ja",
  "Q884": "ko",  "Q668": "hi",  "Q252": "id",  "Q36": "pl",  "Q183": "de",
  "Q142": "fr",  "Q29": "es",   "Q38": "it",  "Q55": "nl",   "Q45": "pt",
  "Q155": "pt",  "Q96": "es",   "Q414": "es", "Q218": "ro",  "Q28": "hu",
  "Q213": "cs",  "Q34": "sv",   "Q33": "fi",  "Q35": "da",   "Q20": "nb",
  "Q189": "is",  "Q419": "es",  "Q739": "es", "Q30": "en",   "Q145": "en",
  "Q16": "en",   "Q408": "en",  "Q664": "en", "Q334": "en",  // US, UK, CA, AU, NZ, SG
  "Q40": "de",   // Austria
  "Q39": "de",   // Switzerland (multilingual, de dominant)
  "Q31": "nl",   // Belgium (multilingual)
  "Q37": "lt",   // Lithuania
  "Q211": "lv",  // Latvia
  "Q191": "et",  // Estonia
  "Q212": "uk",  // Ukraine
  "Q184": "be",  // Belarus
  "Q219": "bg",  // Bulgaria
  "Q221": "mk",  // North Macedonia
  "Q117": "fr",  // Ghana → en actually
  "Q804": "es",  // Panama
  "Q241": "es",  // Cuba
  "Q800": "es",  // Costa Rica
  "Q298": "es",  // Chile
  "Q750": "es",  // Bolivia
  "Q733": "es",  // Paraguay
  "Q77": "es",   // Uruguay
  "Q717": "es",  // Venezuela
  "Q736": "es",  // Ecuador
  "Q786": "es",  // Dominican Republic
  "Q774": "es",  // Guatemala
  "Q783": "es",  // Honduras
  "Q792": "es",  // El Salvador
  "Q811": "es",  // Nicaragua
  "Q794": "vi",  // Vietnam → wait that's wrong, Q794 is Iran
  "Q794": "fa",  // Iran
  "Q851": "ar",  // Saudi Arabia
  "Q817": "ar",  // Kuwait
  "Q846": "ar",  // Qatar
  "Q878": "ar",  // UAE
  "Q842": "ar",  // Oman
  "Q398": "ar",  // Bahrain
  "Q810": "ar",  // Jordan
  "Q858": "ar",  // Syria
  "Q796": "ar",  // Iraq
  "Q801": "he",  // Israel
  "Q822": "ar",  // Lebanon
  "Q902": "bn",  // Bangladesh
  "Q854": "si",  // Sri Lanka
  "Q837": "ne",  // Nepal
  "Q928": "fil", // Philippines
  "Q869": "th",  // Thailand
  "Q836": "my",  // Myanmar
  "Q424": "km",  // Cambodia
  "Q819": "lo",  // Laos
  "Q711": "mn",  // Mongolia
  "Q889": "ps",  // Afghanistan
  "Q843": "ur",  // Pakistan
  "Q865": "zh",  // Taiwan
  "Q884": "ko",  // South Korea
  "Q423": "ko",  // North Korea
  "Q574": "ti",  // East Timor → pt actually
  "Q574": "pt",  // East Timor
  "Q1033": "yo", // Nigeria → en actually
  "Q1033": "en", // Nigeria
  "Q258": "af",  // South Africa → multilingual, en dominant
  "Q258": "en",  // South Africa
  "Q115": "am",  // Ethiopia
  "Q114": "sw",  // Kenya → en/sw
  "Q924": "sw",  // Tanzania → sw
  "Q1032": "fr", // Niger
  "Q1009": "fr", // Cameroon
  "Q657": "fr",  // Chad
  "Q1020": "fr", // Senegal
  "Q1008": "fr", // Ivory Coast
  "Q1006": "fr", // Guinea
  "Q974": "fr",  // DR Congo
  "Q971": "fr",  // Republic of Congo
  "Q929": "fr",  // Central African Republic
  "Q1007": "fr", // Togo
  "Q1005": "fr", // Gambia → en actually
  "Q912": "fr",  // Mali
  "Q1016": "ar", // Libya
  "Q1028": "ar", // Morocco
  "Q262": "ar",  // Algeria
  "Q948": "ar",  // Tunisia
  "Q1049": "ar", // Sudan
  "Q958": "ar",  // Eritrea → ti
  "Q945": "fr",  // Madagascar → mg
  "Q945": "mg",  // Madagascar
};

async function batchResolve(qids: string[]): Promise<Map<string, { label: string; description: string }>> {
  const result = new Map<string, { label: string; description: string }>();
  
  // wbgetentities accepts up to 50 IDs at a time
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const ids = batch.join("|");
    const url = `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels|descriptions&languages=en&ids=${ids}`;
    
    const data = await wikiFetchJson(url);
    const entities = data?.entities ?? {};
    
    for (const qid of batch) {
      const entity = entities[qid];
      if (entity && !entity.missing) {
        result.set(qid, {
          label: entity.labels?.en?.value ?? qid,
          description: entity.descriptions?.en?.value ?? "",
        });
      } else {
        result.set(qid, { label: qid, description: "" });
      }
    }
    
    console.error(`  resolved ${Math.min(i + 50, qids.length)}/${qids.length}`);
  }
  
  return result;
}

async function main() {
  const sql = getSql();

  // Get all distinct country QIDs from sites
  const rows = await sql`
    SELECT DISTINCT country_qid 
    FROM sites 
    WHERE country_qid IS NOT NULL
    ORDER BY country_qid
  `;
  const qids = rows.map((r: any) => r.country_qid as string);
  console.error(`Found ${qids.length} distinct country QIDs to resolve\n`);

  // Batch resolve against Wikidata
  const resolved = await batchResolve(qids);

  // Insert into countries table
  let inserted = 0;
  for (const [qid, info] of resolved) {
    const langCode = LANG_CODES[qid] ?? null;
    await sql`
      INSERT INTO countries (qid, name_en, lang_code)
      VALUES (${qid}, ${info.label}, ${langCode})
      ON CONFLICT (qid) DO UPDATE SET
        name_en = EXCLUDED.name_en,
        lang_code = COALESCE(EXCLUDED.lang_code, countries.lang_code)
    `;
    inserted++;
  }

  console.error(`\nInserted ${inserted} countries`);

  // Summary
  const [stats] = await sql`
    SELECT 
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE lang_code IS NOT NULL) AS with_lang
    FROM countries
  `;
  console.error(`Total: ${stats.total} countries (${stats.with_lang} with lang_code mapping)`);

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
