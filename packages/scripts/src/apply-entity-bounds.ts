/**
 * Applies entity chronological bounds to the timelines ALREADY in the database.
 *
 * This script owns NO business logic. Every rule lives in applyEntityBounds()
 * in @strabon/shared, which the extraction pipeline calls too. Writing those
 * rules twice would guarantee they diverge — probably on an edge case we fix on
 * one side and forget on the other.
 *
 * What this script owns:
 *   - the loop over existing sites (the pipeline only ever sees one at a time)
 *   - --dry-run
 *   - the report
 *
 * WHY IT EXISTS AT ALL
 * --------------------
 * Every NEW extraction is bounded on the way in. This is for the backlog: the
 * timelines extracted before the bounds existed, where a step track's last entry
 * runs forever — "Merovingian culture, France, 1990", "Kingdom of Italy, Milan,
 * 1990". It repairs the past without re-extraction and without a single LLM call.
 *
 * Re-runnable and idempotent: applyEntityBounds() only ever closes and shortens,
 * so a second pass finds nothing left to do.
 *
 * Usage:
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/apply-entity-bounds.ts --dry-run
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/apply-entity-bounds.ts
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/apply-entity-bounds.ts --site Q90
 */

import postgres from "postgres";
import { applyEntityBounds } from "@strabon/shared";
import type {
  BoundsConflict,
  EntityBounds,
  SiteTimeline,
} from "@strabon/shared";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_SITE = args.includes("--site")
  ? args[args.indexOf("--site") + 1]
  : null;

type Reported = BoundsConflict & { site_title: string };

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  // The script talks to the DB directly rather than through @strabon/db, which
  // owns a connection pool meant for the server. Same query, no shared pool.
  const boundsRows = await sql`
    SELECT qid, label_en, inception, inception_precision,
           dissolution, dissolution_precision
    FROM wikidata_entities
    WHERE active AND (inception IS NOT NULL OR dissolution IS NOT NULL)
  `;

  const bounds = new Map<string, EntityBounds>(
    boundsRows.map((r: any) => [
      r.qid,
      {
        label: r.label_en,
        inception: r.inception,
        inception_precision: r.inception_precision,
        dissolution: r.dissolution,
        dissolution_precision: r.dissolution_precision,
      },
    ]),
  );
  console.log(`${bounds.size} bounded entities in the referential\n`);

  const sites = await sql<{ id: string; title_en: string; timeline: any }[]>`
    SELECT id, title_en, timeline
    FROM sites
    WHERE timeline IS NOT NULL
      ${ONLY_SITE ? sql`AND id = ${ONLY_SITE}` : sql``}
    ORDER BY title_en
  `;
  console.log(`${sites.length} sites with a timeline\n`);

  const all: Reported[] = [];
  let sitesChanged = 0;
  let sitesWithConflicts = 0;

  for (const site of sites) {
    const { timeline, conflicts } = applyEntityBounds(
      site.timeline as SiteTimeline,
      bounds,
    );

    for (const c of conflicts) all.push({ ...c, site_title: site.title_en });

    const applied = conflicts.filter((c) => c.action !== "incompatible");
    const hard = conflicts.filter((c) => c.action === "incompatible");

    if (DRY_RUN) continue;

    if (applied.length) {
      await sql`
        UPDATE sites SET timeline = ${sql.json(timeline as any)}
        WHERE id = ${site.id}
      `;
      sitesChanged++;
    }

    // Mirrors recordBoundsConflicts() in @strabon/db: the table is a CURRENT
    // STATE, not a journal. Wiping the site's rows first means a re-run that
    // reconciles an entry makes its conflict DISAPPEAR, instead of piling up.
    await sql`DELETE FROM bounds_conflicts WHERE site_id = ${site.id}`;
    for (const c of hard) {
      await sql`
        INSERT INTO bounds_conflicts (
          site_id, track, entity_qid, entity_label,
          entry_from, entry_to, entity_inception, entity_dissolution, detail
        ) VALUES (
          ${site.id}, ${c.track}, ${c.entity_qid}, ${c.entity_label},
          ${c.entry_from}, ${c.entry_to},
          ${c.entity_inception}, ${c.entity_dissolution}, ${c.detail}
        )
      `;
    }
    if (hard.length) sitesWithConflicts++;
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const of = (a: BoundsConflict["action"]) => all.filter((x) => x.action === a);

  for (const kind of ["close", "shorten", "incompatible"] as const) {
    const list = of(kind);
    if (!list.length) continue;
    console.log(`\n─── ${kind.toUpperCase()} (${list.length}) ───`);
    for (const a of list) {
      console.log(
        `  ${a.site_title.padEnd(18)} ${a.track.padEnd(9)} ` +
          `${a.entity_label.padEnd(32)} ${a.detail}`,
      );
    }
  }

  console.log(`\n─── summary ───`);
  console.log(`  closed       : ${of("close").length}`);
  console.log(`  shortened    : ${of("shorten").length}`);
  console.log(
    `  incompatible : ${of("incompatible").length}  ← human review, NOTHING was changed`,
  );
  console.log(
    DRY_RUN
      ? `\nDRY RUN — nothing was written.`
      : `\n${sitesChanged} sites updated, ${sitesWithConflicts} with conflicts recorded.`,
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
