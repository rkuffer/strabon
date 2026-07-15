/**
 * Backfills `occurrences` on the referential gaps already in the database.
 *
 * WHY
 * ---
 * A gap says "Insubres is missing, signalled by Milan". That cannot be arbitrated:
 * you do not know WHICH entry produced it, over what period, on what evidence.
 *
 * The entry that produced the gap is the real context — its period, its role, its
 * confidence, the source phrases it cites. "Insubres, on Milan, -590 to -222,
 * medium confidence, with this quoted source" is decided in ten seconds.
 *
 * New extractions capture this at record time. This script reconstructs it for the
 * gaps recorded before that — by re-reading the timelines, with no LLM call and no
 * re-extraction.
 *
 * MATCHING
 * --------
 * Same rule as recordGaps: normalised-name equality against the entries of the
 * gap's own track. The model drifts typographically between the two ("Norse/Viking
 * culture" in the track, "Norse / Viking culture" in the gap), and normalisation
 * absorbs that WITHOUT ever matching two genuinely different entities — it stays an
 * equality test on a normalised form, never a fuzzy or partial match.
 *
 * An entry that cannot be matched is reported, not guessed at. If a gap's name no
 * longer appears in any of its sites' timelines, that is a FINDING — usually it
 * means the site has been re-extracted since, and the gap is stale.
 *
 * Idempotent: it rewrites `occurrences` from scratch each time.
 *
 * Usage:
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/backfill-gap-occurrences.ts --dry-run
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/backfill-gap-occurrences.ts
 */

import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Mirrors normaliseName() in referential-gaps.ts. Drop parenthesised qualifiers,
 * lowercase, collapse punctuation and whitespace.
 *
 * Kept in sync BY HAND, which is a smell — if this drifts from the server's copy,
 * the backfill will silently match differently from the pipeline. Worth extracting
 * into @strabon/shared the next time either is touched.
 */
function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type Occurrence = {
  site_id: string;
  from: number | null;
  to: number | null;
  role: string | null;
  confidence: string | null;
  notes: string | null;
  sources: string[];
};

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  const gaps = await sql<
    { id: number; kind: string; name: string; site_ids: string[] }[]
  >`
    SELECT id, kind, name, site_ids
    FROM referential_gaps
    ORDER BY id
  `;

  console.log(`${gaps.length} gaps\n`);
  if (DRY_RUN) console.log("DRY RUN — nothing will be written\n");

  // One pass over every site that any gap mentions.
  const allSiteIds = [...new Set(gaps.flatMap((g) => g.site_ids ?? []))];
  const siteRows = await sql`
    SELECT id, title_en, timeline
    FROM sites
    WHERE id = ANY(${allSiteIds}::TEXT[])
  `;
  const sites = new Map(
    (siteRows as any[]).map((s) => [
      s.id,
      { title: s.title_en, timeline: s.timeline },
    ]),
  );

  let filled = 0;
  let empty = 0;
  const unmatched: string[] = [];

  for (const g of gaps) {
    const occurrences: Occurrence[] = [];

    for (const siteId of g.site_ids ?? []) {
      const site = sites.get(siteId);
      const entries = site?.timeline?.[g.kind]?.entries;
      if (!Array.isArray(entries)) continue;

      const hit = entries.find(
        (e: any) =>
          typeof e?.value?.name === "string" &&
          normaliseName(e.value.name) === normaliseName(g.name),
      );

      if (!hit) {
        unmatched.push(
          `  ${g.kind.padEnd(9)} "${g.name}" on ${site?.title ?? siteId} — ` +
            `no matching entry (site re-extracted since? stale gap?)`,
        );
        continue;
      }

      occurrences.push({
        site_id: siteId,
        from: hit.from ?? null,
        to: hit.to ?? null,
        role: hit.role ?? null,
        confidence: hit.confidence ?? null,
        notes: hit.notes ?? null,
        sources: Array.isArray(hit.sources) ? hit.sources : [],
      });
    }

    if (!occurrences.length) {
      // No site carries this entity any more. The gap is STALE: the run that
      // produced it no longer exists — usually because the site has been
      // re-extracted with a better prompt and the model stopped emitting it.
      //
      // This is deterministic, not heuristic: we are not judging the gap, we are
      // observing that nothing asks for it. Without this, every prompt improvement
      // leaves a layer of ghosts in the human queue, for ever.
      empty++;
      if (!DRY_RUN) {
        await sql`
          UPDATE referential_gaps SET
            status = 'stale',
            resolution_note = 'no site carries this entity any more — superseded by re-extraction',
            resolved_at = now()
          WHERE id = ${g.id} AND status = 'pending'
        `;
      }
      continue;
    }

    console.log(
      `[${String(g.id).padStart(3)}] ${g.kind.padEnd(9)} ${g.name.padEnd(34)} ` +
        occurrences
          .map(
            (o) =>
              `${sites.get(o.site_id)?.title ?? o.site_id}:${o.from ?? "?"}→${o.to ?? ""}`,
          )
          .join("  "),
    );

    if (!DRY_RUN) {
      await sql`
        UPDATE referential_gaps
        SET occurrences = ${sql.json(occurrences as any)}::JSONB
        WHERE id = ${g.id}
      `;
    }
    filled++;
  }

  if (unmatched.length) {
    console.log(`\n─── UNMATCHED (${unmatched.length}) ───`);
    console.log(
      "These gaps name an entity that no longer appears in the site's timeline.\n" +
        "Usually the site has been re-extracted since and the model no longer emits\n" +
        "that entity — the gap is stale and may be worth rejecting.\n",
    );
    for (const u of unmatched) console.log(u);
  }

  console.log(`\n─── summary ───`);
  console.log(`  gaps filled       : ${filled}`);
  console.log(`  gaps with nothing : ${empty}`);
  console.log(`  unmatched entries : ${unmatched.length}`);
  console.log(DRY_RUN ? "\nDRY RUN — nothing was written." : "");

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
