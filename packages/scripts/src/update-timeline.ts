// =============================================================================
// update-timeline.ts — Met à jour la timeline d'un site depuis un fichier JSON
// Synchronise automatiquement les référentiels polities et cultures.
// Met à jour inception_year et dissolution_year depuis la timeline.
//
// Usage :
//   npm run update-timeline -w @strabon/scripts -- --file /path/to/timeline.json
// =============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSql, closeSql, syncReferentialsFromTimeline } from "@strabon/db";
import {
  computeInceptionFromTimeline,
  computeDissolutionFromTimeline,
} from "@strabon/shared";
import type { SiteTimeline } from "@strabon/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Parsing des arguments CLI ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const fileArgIdx = args.indexOf("--file");

if (fileArgIdx === -1 || !args[fileArgIdx + 1]) {
  console.error(
    "Usage: npm run update-timeline -w @strabon/scripts -- --file /path/to/timeline.json",
  );
  process.exit(1);
}

const filePath = path.resolve(args[fileArgIdx + 1]);

if (!fs.existsSync(filePath)) {
  console.error(`❌ Fichier introuvable : ${filePath}`);
  process.exit(1);
}

// ── Lecture et validation ─────────────────────────────────────────────────────
const raw = fs.readFileSync(filePath, "utf-8");
let data: {
  id: string;
  timeline: SiteTimeline;
  timeline_extracted_at?: string;
  timeline_extraction_model?: string;
};

try {
  data = JSON.parse(raw);
} catch (e) {
  console.error("❌ JSON invalide :", e);
  process.exit(1);
}

if (!data.id || !data.timeline) {
  console.error("❌ Le fichier doit contenir au minimum 'id' et 'timeline'.");
  process.exit(1);
}

// ── Mise à jour en base ───────────────────────────────────────────────────────
async function run() {
  const sql = getSql();

  const existing = await sql`
    SELECT id, title_en, timeline_extracted_at, inception_year, dissolution_year
    FROM sites
    WHERE id = ${data.id}
    LIMIT 1
  `;

  if (!existing.length) {
    console.error(`❌ Site introuvable en base : id = ${data.id}`);
    await closeSql();
    process.exit(1);
  }

  const site = existing[0];
  console.log(`📍 Site trouvé : ${site.title_en} (${site.id})`);
  if (site.timeline_extracted_at) {
    console.log(`   Dernière extraction : ${site.timeline_extracted_at}`);
  }

  // Résumé de la timeline
  const tl = data.timeline as any;
  const summary = Object.entries(tl)
    .map(([k, v]: [string, any]) =>
      k === "events"
        ? `events: ${v?.length ?? 0}`
        : `${k}: ${v?.entries?.length ?? 0}`,
    )
    .join(", ");
  console.log(`   Timeline : ${summary}`);

  // Calculer inception et dissolution depuis la timeline
  const inceptionFromTl = computeInceptionFromTimeline(data.timeline);
  const dissolutionFromTl = computeDissolutionFromTimeline(data.timeline);

  if (inceptionFromTl !== null) {
    const prev = site.inception_year;
    console.log(
      `   Inception : ${prev ?? "—"} → ${inceptionFromTl}${inceptionFromTl !== prev ? " ✓ mis à jour" : " (inchangé)"}`,
    );
  }
  if (dissolutionFromTl !== null) {
    const prev = site.dissolution_year;
    console.log(
      `   Dissolution : ${prev ?? "—"} → ${dissolutionFromTl}${dissolutionFromTl !== prev ? " ✓ mis à jour" : " (inchangé)"}`,
    );
  }

  // Mise à jour en base
  await sql`
    UPDATE sites SET
      timeline                  = ${sql.json(data.timeline)},
      timeline_extracted_at     = ${data.timeline_extracted_at ?? new Date().toISOString()},
      timeline_extraction_model = ${data.timeline_extraction_model ?? "manual"},
      -- inception_year : prendre le min entre la valeur LLM et l'existante
      -- (la timeline peut identifier une occupation plus ancienne que Wikidata)
      inception_year            = CASE
                                    WHEN ${inceptionFromTl}::integer IS NOT NULL
                                    THEN LEAST(
                                      ${inceptionFromTl}::integer,
                                      COALESCE(inception_year, ${inceptionFromTl}::integer)
                                    )
                                    ELSE inception_year
                                  END,
      -- dissolution_year : écraser seulement si la timeline l'identifie
      dissolution_year          = COALESCE(${dissolutionFromTl}::integer, dissolution_year),
      last_updated              = now()
    WHERE id = ${data.id}
  `;
  console.log(`✅ Timeline et dates mises à jour pour ${site.title_en}`);

  // Synchronisation des référentiels
  const { polities, cultures } = await syncReferentialsFromTimeline(
    data.timeline,
  );
  if (polities > 0)
    console.log(
      `   +${polities} politi${polities > 1 ? "es" : "e"} ajoutée${polities > 1 ? "s" : ""}`,
    );
  if (cultures > 0)
    console.log(
      `   +${cultures} cultur${cultures > 1 ? "es" : "e"} ajoutée${cultures > 1 ? "s" : ""}`,
    );
  if (polities === 0 && cultures === 0)
    console.log(`   Référentiels déjà à jour`);

  await closeSql();
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
