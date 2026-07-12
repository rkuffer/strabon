// packages/server/src/agent/validate-timeline.ts
// =============================================================================
// Post-extraction QID validation — deterministic, no LLM.
//
// Catches classes of error the prompt cannot reliably prevent:
//
//   1. EMPTY QID — the model writes "wikidata": "" to dodge the "omit the field"
//      instruction. An empty string is not a QID; remove the field.
//
//   2. SELF-CONFESSED WRONG QID — the model writes, in the SAME entry, a note
//      saying the QID is wrong ("omitting wikidata to avoid wrong mapping",
//      "using X as closest broad reference", "no specific QID") AND writes the
//      QID anyway. Observed on Paris: "Parisii (Gallic tribe)" carried Q1051384
//      (= Catuvellauni) with a note admitting it. The model has already done the
//      diagnosis — we simply apply its own conclusion for it.
//
//   3. WRONG KIND — the QID is in the referential but under a different kind than
//      the track it is used on (a religion QID on the culture track). Strip.
//
//   4. CROSS-TRACK REUSE — the same QID on two DIFFERENT tracks. At most one can
//      be right. Strip the non-referential usages.
//
//   5. SAME-TRACK REUSE FOR DIFFERENT ENTITIES — the same QID used on one track
//      for entities with different names. Observed on Gqeberha: three successive
//      regimes ("Cape Colony (Dutch East India Company)", "(British)",
//      "(Batavian Republic)") all sharing one QID. They are distinct entities;
//      at most one is right, and we cannot tell which. Strip all.
//
// IMPORTANT — what is NOT a violation: the same QID reused on the SAME track for
// the SAME entity at different dates. That is normal and expected. Paris returns
// to Q70972 (Kingdom of France) after the English occupation; a religion returns
// after a period of suppression. The previous implementation flagged this and was
// wrong to do so.
//
// Stripped QIDs do NOT delete the entry: it survives with its `name` alone, and is
// added to `missing_entities` so the gaps loop can resolve it properly later.
//
// Religion and language QIDs that are NOT in the referential at all are also
// stripped — the prompt says those tracks may ONLY use referential QIDs, so
// anything else is by definition invented.
// =============================================================================

import type { Sql } from "postgres";

const ENTITY_TRACKS = ["polity", "culture", "religion", "language"] as const;
type EntityTrack = (typeof ENTITY_TRACKS)[number];

// Tracks whose QIDs MUST come from the referential (prompt-enforced).
// For polity/culture the prompt allows the model to use its own knowledge, so an
// unknown QID there is not necessarily wrong — we don't strip those on that basis.
const REFERENTIAL_ONLY: EntityTrack[] = ["religion", "language"];

/**
 * Phrases the model uses when it KNOWS the QID it is writing is wrong or
 * approximate. The prompt forbids this explicitly ("If you find yourself about to
 * write a note like 'QID X used as a broad reference' — STOP and omit"), and the
 * model does it anyway. When such a note sits next to a QID, we trust the note.
 *
 * Kept deliberately specific: these must not fire on legitimate notes.
 */
const CONFESSION_PATTERNS: RegExp[] = [
  /omitting\s+(the\s+)?wikidata/i,
  /omit(ting)?\s+(the\s+)?qid/i,
  /without\s+(a\s+)?(specific\s+)?qid/i,
  /no\s+(specific|exact|precise)\s+(wikidata\s+)?qid/i,
  /\bqid\b[^.]{0,60}\bis wrong\b/i,
  /\bis wrong\b[^.]{0,40}\bomit/i,
  /(as|using)[^.]{0,40}\b(closest|broad|approximate|placeholder|generic)\b[^.]{0,40}\bqid\b/i,
  /\bqid\b[^.]{0,40}\b(closest|broad|approximate|placeholder)\b/i,
  /to avoid (a )?wrong (mapping|match|qid)/i,
];

function isConfessedWrong(notes: unknown): boolean {
  if (typeof notes !== "string" || !notes) return false;
  return CONFESSION_PATTERNS.some((re) => re.test(notes));
}

/** Normalised entity name — used to decide whether two entries are the same thing. */
function normName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Mots-outils ignorés dans la comparaison nom ↔ label du référentiel. */
const STOPWORDS = new Set([
  "the",
  "of",
  "de",
  "la",
  "le",
  "and",
  "et",
  "a",
  "an",
  "kingdom",
  "empire",
  "republic",
  "state",
  "dynasty",
  "period",
  "era",
]);

/**
 * Le nom écrit par le modèle et le label du référentiel désignent-ils PLAUSIBLEMENT
 * la même entité ?
 *
 * Volontairement TOLÉRANT. Le modèle écrit souvent une variante légitime du label
 * ("Republic of South Africa (1961–1994)" pour un label "South Africa"), et stripper
 * cela serait un faux positif coûteux. On ne détecte donc que le cas FRANC : aucun mot
 * significatif en commun.
 *
 * Observé sur Londres : { name: "Germanic peoples", wikidata: "Q273854" } — or Q273854
 * est "Gauls". Aucun mot commun ⇒ le QID ne désigne pas l'entité nommée. Le modèle
 * l'avoue d'ailleurs dans ses notes ("Using Gauls/Germanic entry is imprecise").
 */
function namesPlausiblyMatch(written: string, refLabel: string): boolean {
  const tokens = (s: string) =>
    new Set(
      normName(s)
        .replace(/[()[\],.;:'"–—-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );

  const a = tokens(written);
  const b = tokens(refLabel);

  // Pas assez de matière pour juger ⇒ on ne strippe pas.
  if (!a.size || !b.size) return true;

  for (const w of a) if (b.has(w)) return true;
  return false;
}

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

type Usage = { track: EntityTrack; name: string; entry: any };

/**
 * Validate and clean the QIDs of an extracted timeline.
 * Returns the cleaned timeline plus the list of violations found (for logging and
 * for feeding the referential-gaps loop).
 */
export async function validateTimelineQids(
  sql: Sql<any>,
  timeline: any,
): Promise<ValidationResult> {
  if (!timeline || typeof timeline !== "object" || timeline.rejection) {
    return { timeline, violations: [] };
  }

  const violations: QidViolation[] = [];

  /** Remove the QID from an entry and record why. */
  const strip = (u: Usage, qid: string, reason: string) => {
    if (u.entry?.value) delete u.entry.value.wikidata;
    violations.push({ track: u.track, name: u.name, qid, reason });
  };

  // ── Pass 0: empty QIDs and self-confessed wrong QIDs ────────────────────────
  for (const track of ENTITY_TRACKS) {
    const entries = timeline[track]?.entries;
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const v = entry?.value;
      if (!v || typeof v !== "object") continue;

      const raw = v.wikidata;
      if (typeof raw !== "string") continue;

      // Empty / blank string is not a QID. Silent removal — not worth a violation,
      // the model simply meant "no QID" and expressed it badly.
      if (!raw.trim()) {
        delete v.wikidata;
        continue;
      }

      // The model told us, in its own notes, that this QID is wrong. Believe it.
      if (isConfessedWrong(entry.notes)) {
        strip(
          { track, name: v.name ?? "", entry },
          raw,
          "the entry's own notes state the QID is approximate or should be omitted",
        );
      }
    }
  }

  // ── Collect every remaining QID, per track ─────────────────────────────────
  const used = new Map<string, Usage[]>();

  for (const track of ENTITY_TRACKS) {
    const entries = timeline[track]?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const v = entry?.value;
      const qid = typeof v?.wikidata === "string" ? v.wikidata.trim() : "";
      if (!qid) continue;
      const list = used.get(qid) ?? [];
      list.push({ track, name: v.name ?? "", entry });
      used.set(qid, list);
    }
  }

  if (used.size === 0) {
    recordGapsForViolations(timeline, violations);
    return { timeline, violations };
  }

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

  // ── Check each QID ──────────────────────────────────────────────────────────
  for (const [qid, usages] of used) {
    const ref = known.get(qid);
    const tracks = new Set(usages.map((u) => u.track));
    const names = new Set(usages.map((u) => normName(u.name)).filter(Boolean));

    // Case 1: the QID is in the referential — it may only be used on its own track…
    if (ref) {
      for (const u of usages) {
        if (u.track !== ref.kind) {
          strip(
            u,
            qid,
            `QID belongs to kind '${ref.kind}' ("${ref.label}"), used on '${u.track}' track`,
          );
          continue;
        }
        // …and it must denote the entity the model actually NAMED. A QID whose
        // referential label bears no relation to the written name is an attribution
        // error, whatever the track.
        if (u.name && !namesPlausiblyMatch(u.name, ref.label)) {
          strip(
            u,
            qid,
            `QID "${qid}" is "${ref.label}" in the referential, but the entry names "${u.name}" — these are not the same entity`,
          );
        }
      }

      // Even on the right track, one QID cannot denote two different entities.
      const onRightTrack = usages.filter(
        (u) => u.track === ref.kind && u.entry?.value?.wikidata,
      );
      const rightTrackNames = new Set(
        onRightTrack.map((u) => normName(u.name)).filter(Boolean),
      );
      if (rightTrackNames.size > 1) {
        for (const u of onRightTrack) {
          strip(
            u,
            qid,
            `one QID ("${ref.label}") used for ${rightTrackNames.size} different entities on the '${u.track}' track: ${[...rightTrackNames].join(" / ")}`,
          );
        }
      }
      continue;
    }

    // Case 2: the QID is NOT in the referential.

    // 2a. religion/language may ONLY use referential QIDs — anything else is invented.
    for (const u of usages) {
      if (REFERENTIAL_ONLY.includes(u.track)) {
        strip(
          u,
          qid,
          `QID not in the ${u.track} referential (${u.track} QIDs must come from it)`,
        );
      }
    }

    const rest = usages.filter((u) => !REFERENTIAL_ONLY.includes(u.track));
    if (!rest.length) continue;

    // 2b. Same QID on DIFFERENT tracks ⇒ at most one usage can be right.
    if (tracks.size > 1) {
      for (const u of rest) {
        strip(
          u,
          qid,
          `same QID used on ${tracks.size} different tracks (${[...tracks].join(", ")})`,
        );
      }
      continue;
    }

    // 2c. Same track, but the QID denotes SEVERAL DIFFERENT entities (different
    //     names) ⇒ at most one is right and we cannot tell which. Strip all.
    //     (Same track + same name at different dates is LEGITIMATE — a polity can
    //     return, e.g. Kingdom of France after the English occupation of Paris.)
    if (names.size > 1) {
      for (const u of rest) {
        strip(
          u,
          qid,
          `one QID used for ${names.size} different entities on the '${u.track}' track: ${[...names].join(" / ")}`,
        );
      }
    }
  }

  recordGapsForViolations(timeline, violations);
  return { timeline, violations };
}

/**
 * Every stripped entry becomes a referential gap, so the gaps loop can resolve it
 * properly (with human review or Wikidata verification).
 *
 * We do NOT carry the stripped QID as `proposed_qid`: it was wrong by definition —
 * that is why it was stripped — and re-proposing it would feed the same error back
 * into the verification loop.
 */
function recordGapsForViolations(timeline: any, violations: QidViolation[]) {
  if (!violations.length) return;

  const missing = Array.isArray(timeline.missing_entities)
    ? timeline.missing_entities
    : [];

  for (const v of violations) {
    if (!v.name) continue;
    const already = missing.some(
      (m: any) => m?.kind === v.track && normName(m?.name) === normName(v.name),
    );
    if (already) continue;
    missing.push({
      kind: v.track,
      name: v.name,
      context: `QID stripped by validation: ${v.reason}`,
    });
  }

  timeline.missing_entities = missing;
}
