/**
 * Applies entity chronological bounds to the timelines already in the database.
 *
 * WHY
 * ---
 * A step track has no termination mechanism. Its last entry runs forever, so the
 * model's correct silence ("documented history has begun, I stop here") becomes
 * our renderer's false assertion: "Merovingian culture, France, 1990" and
 * "Kingdom of Italy, Milan, 1990".
 *
 * Entity bounds close them deterministically, WITHOUT re-extraction and WITHOUT
 * depending on the model's obedience — which we have measured, repeatedly, to be
 * unreliable in exactly the way that matters.
 *
 * THE THREE CASES (arbitrated, not invented)
 * ------------------------------------------
 * A bound is a CEILING, never a truth. We never widen; we only ever cut. And we
 * only ever cut when cutting cannot destroy a fact.
 *
 *   1. CLOSE — the entry runs past the entity's dissolution.
 *      → set `to = dissolution`. AUTOMATIC.
 *      This ADDS information that was missing; it erases nothing. The entry keeps
 *      its name, its start, its notes. Worst case, a bound is off by twenty years
 *      (Wikidata says the Kingdom of Munster ended in 1138, Wikipedia says 1118)
 *      on an entry that was overshooting by eight hundred. The residual error is
 *      marginal AND visible.
 *
 *   2. SHORTEN — the entry starts before the entity was born, but they OVERLAP.
 *      → raise `from` to the entity's inception. AUTOMATIC, but logged.
 *      This is a SUB-INTERVAL of what the model already asserted: we say less
 *      than it did, never something else. "Standard Chinese, state language, 550"
 *      becomes "from 1949" — which is true. Deleting would have lost a real fact.
 *      The shortened entry INHERITS the entity's precision: an entity born "circa
 *      -4500" must not turn a fuzzy bound into a hard date. That is the very vice
 *      we hunt everywhere else.
 *
 *   3. INCOMPATIBLE — no overlap at all. The entry lies entirely before the
 *      entity's birth, or entirely after its death.
 *      → CHANGE NOTHING. Record for human review, high priority.
 *      There is nothing to shorten here: the entry and the entity are simply
 *      irreconcilable, and we cannot know WHICH of the two is wrong. Bounds come
 *      from Wikidata, which encodes medieval legend at year-level precision (the
 *      Kingdom of Munster "begins" in 100 BC because Irish chroniclers needed
 *      royal lines to reach back that far). Deleting a true fact on the strength
 *      of a false bound would replace one error with a less visible one.
 *      A wrong entry that is VISIBLE can be curated. A deleted entry is a silent
 *      hole.
 *
 * WHAT IS NOT LOST
 * ----------------
 * `site_extractions` holds the raw timeline of every run. `sites.timeline` is the
 * CURATED artefact, not the data. Nothing this script touches is unrecoverable.
 *
 * DEPENDENCY
 * ----------
 * This script writes `to` on step tracks (polity, culture). Nothing reads it yet:
 * stripTo() erases it, track_active_entries('step') ignores it, getEntryAt()
 * ignores it, and TimelineTrack.vue stretches the segment to the next entry.
 * The step-track closure support must land FIRST, or this script is a no-op on
 * screen.
 *
 * Usage:
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/apply-entity-bounds.ts --dry-run
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/apply-entity-bounds.ts
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/apply-entity-bounds.ts --site Q90
 */

import postgres from "postgres";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_SITE = args.includes("--site")
  ? args[args.indexOf("--site") + 1]
  : null;

/**
 * Tracks whose entries name an ENTITY, and can therefore be bounded.
 * `name`, `population` and `site_type` carry no entity — nothing to bound.
 */
const BOUNDED_TRACKS = ["polity", "culture", "religion", "language"] as const;
type BoundedTrack = (typeof BOUNDED_TRACKS)[number];

const STEP_TRACKS: ReadonlySet<string> = new Set(["polity", "culture"]);

type Bounds = {
  inception: number | null;
  inception_precision: number | null;
  dissolution: number | null;
  dissolution_precision: number | null;
  label_en: string;
};

type Entry = {
  from: number;
  to?: number | null;
  from_circa?: boolean;
  from_precision?: number;
  value: { name?: string; wikidata?: string };
  role?: string;
  notes?: string;
  confidence?: string;
  [k: string]: unknown;
};

type Action = {
  site_id: string;
  site_title: string;
  track: BoundedTrack;
  entity_qid: string;
  entity_label: string;
  entry_from: number;
  entry_to: number | null;
  implicit_end: number | null;
  inception: number | null;
  dissolution: number | null;
  action: "close" | "shorten" | "incompatible";
  detail: string;
};

/**
 * Identity key of a track value, mirroring entityKey() in timeline-utils.ts.
 * We only bound entries that carry a QID: without one there is no entity to look
 * up, and a name is not an identity.
 */
function qidOf(e: Entry): string | null {
  const q =
    typeof e.value?.wikidata === "string" ? e.value.wikidata.trim() : "";
  return q || null;
}

/**
 * The year at which an entry currently STOPS being displayed.
 *
 *   step        : the next entry of the track closes it, whatever its entity.
 *                 A polity is always replaced by another, never by nothing.
 *   cooccurrent : only an explicit `to`, or a later entry of the SAME entity
 *                 (a role change), closes it. Otherwise it runs forever.
 *
 * `null` means "runs to the end of the timeline" — the open tail we are here to
 * cut.
 */
function implicitEnd(
  entries: Entry[],
  i: number,
  track: BoundedTrack,
): number | null {
  const e = entries[i];
  if (e.to != null) return e.to;

  if (STEP_TRACKS.has(track)) {
    return i + 1 < entries.length ? entries[i + 1].from : null;
  }

  const key = qidOf(e) ?? e.value?.name ?? "";
  for (let j = i + 1; j < entries.length; j++) {
    const k = qidOf(entries[j]) ?? entries[j].value?.name ?? "";
    if (k === key) return entries[j].from;
  }
  return null;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  // ── Bounds referential ──────────────────────────────────────────────────────
  const boundsRows = await sql<({ qid: string } & Bounds)[]>`
    SELECT qid, label_en, inception, inception_precision,
           dissolution, dissolution_precision
    FROM wikidata_entities
    WHERE inception IS NOT NULL OR dissolution IS NOT NULL
  `;
  const bounds = new Map<string, Bounds>(
    boundsRows.map((r) => [r.qid, r as Bounds]),
  );
  console.log(`${bounds.size} bounded entities in the referential\n`);

  // ── Sites ───────────────────────────────────────────────────────────────────
  const sites = await sql<{ id: string; title_en: string; timeline: any }[]>`
    SELECT id, title_en, timeline
    FROM sites
    WHERE timeline IS NOT NULL
      ${ONLY_SITE ? sql`AND id = ${ONLY_SITE}` : sql``}
    ORDER BY title_en
  `;
  console.log(`${sites.length} sites with a timeline\n`);

  const actions: Action[] = [];
  let sitesChanged = 0;

  for (const site of sites) {
    const timeline = site.timeline as Record<string, { entries?: Entry[] }>;
    let changed = false;

    for (const track of BOUNDED_TRACKS) {
      const entries = timeline[track]?.entries;
      if (!entries?.length) continue;

      entries.sort((a, b) => a.from - b.from);

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const qid = qidOf(e);
        if (!qid) continue;

        const b = bounds.get(qid);
        if (!b) continue;

        const end = implicitEnd(entries, i, track);
        const base = {
          site_id: site.id,
          site_title: site.title_en,
          track,
          entity_qid: qid,
          entity_label: b.label_en,
          entry_from: e.from,
          entry_to: e.to ?? null,
          implicit_end: end,
          inception: b.inception,
          dissolution: b.dissolution,
        };

        // ── 3. INCOMPATIBLE — no overlap. Touch nothing, flag loudly. ─────────
        // Entirely after the entity died:
        if (b.dissolution != null && e.from > b.dissolution) {
          actions.push({
            ...base,
            action: "incompatible",
            detail: `entry starts at ${e.from}, entity died in ${b.dissolution} — entry is entirely after the entity's life`,
          });
          continue;
        }
        // Entirely before the entity was born.
        //
        // STRICT inequality: an entry that ends exactly ON the entity's inception
        // year still overlaps it. `Rome / Roman Republic, 1849→1849, born 1849`
        // is a perfect match, not a conflict — the non-strict test was flagging
        // every entry whose whole life is a single year.
        if (b.inception != null && end != null && end < b.inception) {
          actions.push({
            ...base,
            action: "incompatible",
            detail: `entry runs ${e.from}→${end}, entity born in ${b.inception} — entry is entirely before the entity's life`,
          });
          continue;
        }

        // ── 2. SHORTEN — starts too early, but overlaps. ──────────────────────
        //
        // Never shorten an entry into nothing. If raising `from` to the entity's
        // inception would push it past the entry's own end, there is no overlap
        // left to keep — and that is a conflict for a human, not a silent edit.
        // (The INCOMPATIBLE test above already catches `end < inception`; this
        // guards the boundary where end == inception.)
        if (
          b.inception != null &&
          e.from < b.inception &&
          (end == null || b.inception < end)
        ) {
          actions.push({
            ...base,
            action: "shorten",
            detail: `from ${e.from} → ${b.inception} (entity inception)`,
          });
          if (!DRY_RUN) {
            e.from = b.inception;
            // Inherit the entity's imprecision. Without this we would turn
            // "circa 4500 BC" into a hard fact.
            if (b.inception_precision != null && b.inception_precision < 9) {
              e.from_circa = true;
              e.from_precision = b.inception_precision;
            }
            changed = true;
          }
        }

        // ── 1. CLOSE — runs past the entity's dissolution. ────────────────────
        // Note this is evaluated AFTER shorten: an entry can need both.
        if (
          b.dissolution != null &&
          (end == null || end > b.dissolution) &&
          b.dissolution >= e.from
        ) {
          actions.push({
            ...base,
            action: "close",
            detail:
              end == null
                ? `open tail → closed at ${b.dissolution} (entity dissolution)`
                : `ran to ${end} → closed at ${b.dissolution} (entity dissolution)`,
          });
          if (!DRY_RUN) {
            e.to = b.dissolution;
            changed = true;
          }
        }
      }
    }

    if (changed && !DRY_RUN) {
      await sql`
        UPDATE sites SET timeline = ${sql.json(timeline)} WHERE id = ${site.id}
      `;
      sitesChanged++;
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const byAction = (a: Action["action"]) =>
    actions.filter((x) => x.action === a);

  for (const kind of ["close", "shorten", "incompatible"] as const) {
    const list = byAction(kind);
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
  console.log(`  closed       : ${byAction("close").length}`);
  console.log(`  shortened    : ${byAction("shorten").length}`);
  console.log(
    `  incompatible : ${byAction("incompatible").length}  ← human review`,
  );
  console.log(
    DRY_RUN
      ? `\nDRY RUN — nothing was written.`
      : `\n${sitesChanged} sites updated.`,
  );

  // Persist the incompatible cases: they are the ONLY ones a human must arbitrate.
  const conflicts = byAction("incompatible");
  if (conflicts.length && !DRY_RUN) {
    for (const c of conflicts) {
      await sql`
        INSERT INTO bounds_conflicts (
          site_id, track, entity_qid, entity_label,
          entry_from, entry_to, entity_inception, entity_dissolution, detail
        ) VALUES (
          ${c.site_id}, ${c.track}, ${c.entity_qid}, ${c.entity_label},
          ${c.entry_from}, ${c.entry_to}, ${c.inception}, ${c.dissolution},
          ${c.detail}
        )
        ON CONFLICT (site_id, track, entity_qid, entry_from) DO UPDATE
          SET detail = EXCLUDED.detail, last_seen_at = now()
      `;
    }
    console.log(`${conflicts.length} conflicts recorded in bounds_conflicts.`);
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
