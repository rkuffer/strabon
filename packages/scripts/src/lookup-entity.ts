// packages/scripts/src/lookup-entity.ts
// =============================================================================
// Harnais de test CLI pour searchEntities (référentiel d'autorité Wikidata).
//
// Usage :
//   DATABASE_URL=... npx tsx packages/scripts/src/lookup-entity.ts "Roman Republic"
//   DATABASE_URL=... npx tsx packages/scripts/src/lookup-entity.ts "Shang" --kind=culture
// =============================================================================

import { searchEntities, closeSql } from "@strabon/db";

async function main() {
  const argv = process.argv.slice(2);
  const kind = argv.find((a) => a.startsWith("--kind="))?.split("=")[1] ?? null;
  const query = argv.filter((a) => !a.startsWith("--")).join(" ");

  if (!query) {
    console.error(
      'Usage : npx tsx packages/scripts/src/lookup-entity.ts "<nom>" [--kind=polity|culture]',
    );
    process.exit(1);
  }

  const candidates = await searchEntities(query, { kind, limit: 10 });

  console.log(
    `\nRecherche : "${query}"${kind ? ` (kind=${kind})` : ""} — ${candidates.length} candidat(s)\n`,
  );
  for (const c of candidates) {
    const score = c.score.toFixed(3);
    const country = c.country_qid ? ` [${c.country_qid}]` : "";
    console.log(`  ${score}  ${c.qid.padEnd(10)} ${c.kind.padEnd(8)} ${c.label_en}${country}`);
    if (c.description_en) console.log(`         ↳ ${c.description_en}`);
  }
  console.log();

  await closeSql();
}

main().catch((err) => {
  console.error("ÉCHEC:", err);
  process.exit(1);
});
