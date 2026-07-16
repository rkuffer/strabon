// =============================================================================
// migrate.ts — Migration de index.json vers PostgreSQL
// Usage : npx tsx src/migrate.ts [--file /path/to/index.json]
// =============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { upsertSite, closeSql } from "@strabon/db";
import type { Index } from "@strabon/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Résolution du fichier index.json ─────────────────────────────────────────
const args = process.argv.slice(2);
const fileArgIdx = args.indexOf("--file");
const indexPath = fileArgIdx !== -1
  ? args[fileArgIdx + 1]
  : path.join(__dirname, "../../output/index.json");

if (!fs.existsSync(indexPath)) {
  console.error(`❌ index.json introuvable : ${indexPath}`);
  console.error("Usage : npx tsx src/migrate.ts [--file /path/to/index.json]");
  process.exit(1);
}

// base_importance n'est plus calculé ici : c'est désormais une colonne GÉNÉRÉE
// (dérivée de sitelinks_count + article EN, voir schema.sql /
// migration-base-importance.sql). L'ancien calcul par taille d'article est
// caduc.

// ── Migration ─────────────────────────────────────────────────────────────────
async function migrate() {
  console.log(`📂 Lecture de ${indexPath}...`);
  const raw = fs.readFileSync(indexPath, "utf-8");
  const index: Index = JSON.parse(raw);
  const entries = Object.entries(index);

  console.log(`🏛  ${entries.length} sites à migrer vers PostgreSQL...`);

  let done = 0, errors = 0;
  const BATCH = 50;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await Promise.all(batch.map(async ([title, entry]) => {
      try {
        await upsertSite({
          id:                      entry.id,
          wikidata_id:             entry.wikidata_id,
          title_en:                title,
          wikipedia_page_en_url:   entry.wikipedia_page_en_url,
          source:                  entry.source,
          lat:                     entry.coordinates?.lat,
          lon:                     entry.coordinates?.lon,
          country:                 entry.country,
          country_qid:             entry.country_qid,
          inception_year:          entry.inception?.year,
          dissolution_year:        entry.dissolution?.year,
          site_type:               entry.site_type,
          names:                   entry.names,
          timeline:                entry.timeline as object | undefined,
          meta: {
            description:    entry.description,
            native_label:   entry.native_label,
            cultures:       entry.cultures,
            inception:      entry.inception,
            dissolution:    entry.dissolution,
          },
          wikidata_enriched_at:     entry.wikidata_enriched_at
            ? new Date(entry.wikidata_enriched_at) : undefined,
          timeline_extracted_at:    entry.timeline_extracted_at
            ? new Date(entry.timeline_extracted_at) : undefined,
          timeline_extraction_model: entry.timeline_extraction_model,
        });
        done++;
      } catch (err) {
        console.error(`  ❌ ${title}: ${err}`);
        errors++;
      }
    }));

    const progress = Math.min(i + BATCH, entries.length);
    process.stdout.write(`\r  ${progress}/${entries.length} (${errors} erreurs)`);
  }

  console.log(`\n✅ Migration terminée : ${done} insérés, ${errors} erreurs.`);
  await closeSql();
}

migrate().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
