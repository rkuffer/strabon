// packages/scripts/src/dump-runs.ts
// =============================================================================
// Dump every extraction run, grouped by site, for variance analysis.
//
// Usage:
//   npx tsx packages/scripts/src/dump-runs.ts [minRuns] [outDir]
//
//   npx tsx packages/scripts/src/dump-runs.ts        # sites with >= 2 runs → ./run-dump
//   npx tsx packages/scripts/src/dump-runs.ts 3      # only sites with >= 3 runs
//
// Produces, in outDir:
//   _runs.json     every site with all its runs — the one to share
//   _summary.txt   overview: runs per site, entry counts per run
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

async function main() {
  const minRuns = Number(process.argv[2] ?? 2);
  const outDir = resolve(process.argv[3] ?? "./run-dump");

  const sql = getSql();

  const rows = await sql`
    SELECT
      e.id,
      e.site_id,
      s.title_en,
      s.country_qid,
      s.sitelinks_count,
      e.timeline,
      e.model,
      e.prompt_hash,
      e.referential_hash,
      e.local_lang,
      e.qid_violations,
      e.rejected,
      e.rejection_reason,
      e.confirmed,
      e.run_at
    FROM site_extractions e
    JOIN sites s ON s.id = e.site_id
    WHERE e.site_id IN (
      SELECT site_id FROM site_extractions
      GROUP BY site_id HAVING COUNT(*) >= ${minRuns}
    )
    ORDER BY e.site_id, e.run_at ASC
  `;

  if (!rows.length) {
    console.log(`No site has >= ${minRuns} runs.`);
    await closeSql();
    return;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Group by site.
  const bySite = new Map<string, any>();

  for (const r of rows as any[]) {
    let site = bySite.get(r.site_id);
    if (!site) {
      site = {
        site_id: r.site_id,
        title_en: r.title_en,
        country_qid: r.country_qid,
        sitelinks_count: r.sitelinks_count,
        runs: [],
      };
      bySite.set(r.site_id, site);
    }

    site.runs.push({
      run_id: r.id,
      run_at: r.run_at,
      model: r.model,
      prompt_hash: r.prompt_hash,
      referential_hash: r.referential_hash,
      local_lang: r.local_lang,
      qid_violations: r.qid_violations,
      rejected: r.rejected,
      rejection_reason: r.rejection_reason,
      confirmed: r.confirmed,
      timeline: r.timeline ?? {},
    });
  }

  const all = [...bySite.values()];

  // Summary.
  const lines: string[] = [];
  for (const s of all) {
    lines.push(
      `\n${s.site_id}  ${s.title_en}  (${s.runs.length} runs, ${s.sitelinks_count ?? "?"} sitelinks)`,
    );
    for (const run of s.runs) {
      const tl = run.timeline ?? {};
      const counts = TRACKS.map((t) => {
        const n = (tl?.[t]?.entries ?? []).length;
        return `${t.slice(0, 4)}:${n}`;
      }).join(" ");
      const when = new Date(run.run_at)
        .toISOString()
        .slice(11, 16);
      lines.push(
        `  #${String(run.run_id).padStart(3)} ${when} ` +
          `${run.prompt_hash?.slice(0, 8) ?? "—"} ` +
          `${run.rejected ? "REJECTED " : ""}` +
          `${counts} ev:${(tl.events ?? []).length} ` +
          `miss:${(tl.missing_entities ?? []).length} v:${run.qid_violations}`,
      );
    }
  }

  await writeFile(
    join(outDir, "_runs.json"),
    JSON.stringify(all, null, 2),
    "utf8",
  );
  await writeFile(join(outDir, "_summary.txt"), lines.join("\n") + "\n", "utf8");

  const totalRuns = all.reduce((n, s) => n + s.runs.length, 0);
  console.log(
    `${all.length} site(s), ${totalRuns} run(s) written to ${outDir}\n`,
  );
  console.log(lines.join("\n"));
  console.log(`\n→ share ${join(outDir, "_runs.json")}`);

  await closeSql();
}

main().catch(async (err) => {
  console.error(err);
  await closeSql().catch(() => {});
  process.exit(1);
});
