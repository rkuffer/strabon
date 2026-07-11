// packages/server/src/agent/validate-timeline.ts
// =============================================================================
// Post-extraction QID validation — deterministic, no LLM.
//
// Catches a class of error the prompt cannot reliably prevent: the model
// reusing a QID across tracks (e.g. giving the culture track the QID of a
// religion it saw in the religion referential), or inventing a QID outright.
//
// Two checks:
//   1. CROSS-TRACK REUSE — the same QID appears on two different tracks.
//      At most one can be right. We keep it on the track whose `kind` matches
//      the referential, and strip it from the other(s).
//   2. WRONG KIND — a QID is in the referential but under a different kind
//      than the track it's used on (e.g. Q1122452 is kind='religion', used on
//      the culture track). Strip it.
//
// Stripped QIDs do NOT delete the entry: the entry survives with its `name`
// alone, and is added to `missing_entities` so the gaps loop can resolve it
// properly later.
//
// Religion and language QIDs that are NOT in the referential at all are also
// stripped — the prompt says those tracks may ONLY use referential QIDs, so
// anything else is by definition invented.
// =============================================================================

import type { Sql } from "postgres";

const ENTITY_TRACKS = ["polity", "culture", "religion", "language"] as const;
type EntityTrack = (typeof ENTITY_TRACKS)[number];

// Tracks whose QIDs MUST come from the referential (prompt-enforced).
// For polity/culture the prompt allows the model to use its own knowledge,
// so an unknown QID there is not necessarily wrong — we don't strip those.
const REFERENTIAL_ONLY: EntityTrack[] = ["religion", "language"];

export type QidViolation = {
  track: EntityTrack;
  name: string;
  qid: string;
  reason: string;
};

export type ValidationResult = {
  timeline: any;
  violations: QidViolation[];
};

/**
 * Validate and clean the QIDs of an extracted timeline.
 * Returns the cleaned timeline plus the list of violations found (for logging
 * and for feeding the referential-gaps loop).
 */
export async function validateTimelineQids(
  sql: Sql<any>,
  timeline: any,
): Promise<ValidationResult> {
  if (!timeline || typeof timeline !== "object" || timeline.rejection) {
    return { timeline, violations: [] };
  }

  // ── Collect every QID used, per track ───────────────────────────────────────
  const used = new Map<
    string,
    { track: EntityTrack; name: string; entry: any }[]
  >();

  for (const track of ENTITY_TRACKS) {
    const entries = timeline[track]?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const v = entry?.value;
      const qid = v?.wikidata;
      if (!qid || typeof qid !== "string") continue;
      const list = used.get(qid) ?? [];
      list.push({ track, name: v.name ?? "", entry });
      used.set(qid, list);
    }
  }

  if (used.size === 0) return { timeline, violations: [] };

  // ── Look up the true kind of each QID in the referential ────────────────────
  const qids = [...used.keys()];
  const rows = await sql`
    SELECT qid, kind, label_en
    FROM wikidata_entities
    WHERE qid = ANY(${qids})
  `;
  const known = new Map<string, { kind: string; label: string }>(
    rows.map((r: any) => [r.qid, { kind: r.kind, label: r.label_en }]),
  );

  const violations: QidViolation[] = [];

  // ── Check each QID ──────────────────────────────────────────────────────────
  for (const [qid, usages] of used) {
    const ref = known.get(qid);

    // Case 1: QID is in the referential — it may only be used on its own track.
    if (ref) {
      for (const u of usages) {
        if (u.track !== ref.kind) {
          delete u.entry.value.wikidata;
          violations.push({
            track: u.track,
            name: u.name,
            qid,
            reason: `QID belongs to kind '${ref.kind}' ("${ref.label}"), used on '${u.track}' track`,
          });
        }
      }
      continue;
    }

    // Case 2: QID is NOT in the referential.
    for (const u of usages) {
      // religion/language may ONLY use referential QIDs — anything else is invented.
      if (REFERENTIAL_ONLY.includes(u.track)) {
        delete u.entry.value.wikidata;
        violations.push({
          track: u.track,
          name: u.name,
          qid,
          reason: `QID not in the ${u.track} referential (${u.track} QIDs must come from it)`,
        });
        continue;
      }

      // polity/culture: the prompt allows model knowledge, so an unknown QID is
      // not automatically wrong. BUT if the same QID is also used on another
      // track, at least one usage is wrong — strip the non-referential ones.
      if (usages.length > 1) {
        delete u.entry.value.wikidata;
        violations.push({
          track: u.track,
          name: u.name,
          qid,
          reason: `same QID reused across ${usages.length} tracks (${usages.map((x) => x.track).join(", ")})`,
        });
      }
    }
  }

  // ── Any entry we stripped becomes a referential gap ─────────────────────────
  if (violations.length) {
    const missing = Array.isArray(timeline.missing_entities)
      ? timeline.missing_entities
      : [];

    for (const v of violations) {
      const already = missing.some(
        (m: any) => m?.kind === v.track && m?.name === v.name,
      );
      if (!already && v.name) {
        // NOTE: we do NOT carry the stripped QID as proposed_qid — it was wrong
        // ON THIS TRACK by definition (that is why it was stripped). Proposing it
        // again would just feed the same error back into the verification loop.
        missing.push({
          kind: v.track,
          name: v.name,
          context: `QID stripped by validation: ${v.reason}`,
        });
      }
    }

    timeline.missing_entities = missing;
  }

  return { timeline, violations };
}
