// packages/scripts/src/dump-timelines.ts
// =============================================================================
// Dump the most recently extracted site timelines to JSON files, for review.
//
// Usage:
//   npx tsx packages/scripts/src/dump-timelines.ts [count] [outDir]
//
//   npx tsx packages/scripts/src/dump-timelines.ts              # 10 sites → ./timeline-dump
//   npx tsx packages/scripts/src/dump-timelines.ts 20           # 20 sites
//   npx tsx packages/scripts/src/dump-timelines.ts 10 /tmp/out  # custom directory
//
// Produces, in outDir:
//   <QID>-<slug>.json   one file per site (full record: metadata + timeline)
//   _all.json           every site in a single array — the convenient one to share
//   _summary.txt        one-line-per-site overview (entry counts per track)
// =============================================================================

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSql, closeSql } from "@strabon/db";

const TRACKS = [
  "site_type",
  "polity",
  "culture",
  "religion",
  "language",
  "name",
  "population",
] as const;

function slugify(s: string): string {
  return (
    (s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "untitled"
  );
}

async function main() {
  const count = Number(process.argv[2] ?? 10);
  const outDir = resolve(process.argv[3] ?? "./timeline-dump");

  if (!Number.isFinite(count) || count < 1) {
    console.error("Usage: tsx dump-timelines.ts [count] [outDir]");
    process.exit(1);
  }

  const sql = getSql();

  const rows = await sql`
    SELECT
      id,
      title_en,
      wikipedia_page_en_url,
      country,
      country_qid,
      ST_Y(location) AS lat,
      ST_X(location) AS lon,
      enrichment_level,
      sitelinks_count,
      population,
      inception_year,
      dissolution_year,
      timeline,
      timeline_extracted_at,
      timeline_extraction_model,
      meta
    FROM sites
    WHERE timeline IS NOT NULL
      AND timeline_extracted_at IS NOT NULL
    ORDER BY timeline_extracted_at DESC
    LIMIT ${count}
  `;

  if (!rows.length) {
    console.log("No extracted timelines found.");
    await closeSql();
    return;
  }

  // Fresh directory each run, so an old dump can't be mistaken for a new one.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const summary: string[] = [];
  const all: any[] = [];

  for (const r of rows as any[]) {
    const tl = r.timeline ?? {};

    const counts = TRACKS.map((t) => {
      const n = tl?.[t]?.entries?.length ?? 0;
      return `${t}:${n}`;
    });
    counts.push(`events:${tl?.events?.length ?? 0}`);
    counts.push(`missing:${tl?.missing_entities?.length ?? 0}`);

    const record = {
      id: r.id,
      title_en: r.title_en,
      country_qid: r.country_qid,
      coordinates: { lat: r.lat, lon: r.lon },
      enrichment_level: r.enrichment_level,
      sitelinks_count: r.sitelinks_count,
      inception_year: r.inception_year,
      dissolution_year: r.dissolution_year,
      extracted_at: r.timeline_extracted_at,
      model: r.timeline_extraction_model,
      meta: r.meta ?? {},
      timeline: tl,
    };

    all.push(record);

    const file = `${r.id}-${slugify(r.title_en)}.json`;
    await writeFile(
      join(outDir, file),
      JSON.stringify(record, null, 2),
      "utf8",
    );

    const when = r.timeline_extracted_at
      ? new Date(r.timeline_extracted_at)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ")
      : "—";
    summary.push(
      `${String(r.id).padEnd(10)} ${String(r.title_en).padEnd(24)} ${when}  ${counts.join(" ")}`,
    );
    console.log(`  ✓ ${file}`);
  }

  await writeFile(
    join(outDir, "_all.json"),
    JSON.stringify(all, null, 2),
    "utf8",
  );
  await writeFile(
    join(outDir, "_summary.txt"),
    summary.join("\n") + "\n",
    "utf8",
  );

  console.log(`\n${rows.length} timeline(s) written to ${outDir}`);
  console.log(`  _all.json      — every site in one array (share this one)`);
  console.log(`  _summary.txt   — overview\n`);
  console.log(summary.join("\n"));

  await closeSql();
}

main().catch(async (err) => {
  console.error(err);
  await closeSql().catch(() => {});
  process.exit(1);
});
