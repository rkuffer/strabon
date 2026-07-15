// packages/server/src/agent/referential-gaps.ts
// =============================================================================
// Referential gaps — recording, resolution, and backfill.
//
// RECORDING: after an extraction, missing_entities are written to referential_gaps
// (deduplicated by kind+name; site_ids accumulates). Gaps the model already
// resolved in the timeline are filtered out as spurious.
//
// RESOLUTION: a deterministic pass verifies the LLM-proposed QID against Wikidata
// (exists? correct type? label plausible?). If it checks out → insert into
// wikidata_entities + backfill all sites that signaled the gap. Otherwise → leave
// pending for human review.
//
// BACKFILL: once an entity is in the referential, every site whose timeline has an
// entry of that kind with that name (and no wikidata field) gets the QID injected.
// No LLM call, no re-extraction.
// =============================================================================

import type { Sql } from "postgres";
import { wikiFetchJson } from "./wiki-fetch.js";
import { syncBoundsForNewEntity } from "./entity-bounds-sync.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// ── Expected Wikidata types per kind ──────────────────────────────────────────
// Used to verify that a proposed QID is actually the right sort of entity.
// We check P31 (instance of) and P279 (subclass of) against these roots.

const EXPECTED_ROOTS: Record<string, string[]> = {
  religion: ["Q9174", "Q179805", "Q1530022"], // religion, religious denomination, religious movement
  language: ["Q34770", "Q17376908", "Q436240"], // language, languoid, ancient language
  polity: ["Q7275", "Q3624078", "Q6256", "Q3024240", "Q1250464", "Q48349"], // state, sovereign state, country, historical country, realm, empire
  culture: ["Q465299", "Q11042", "Q28171"], // archaeological culture, culture, civilization
};

// ── Name matching ─────────────────────────────────────────────────────────────

/**
 * Normalise an entity name for matching.
 *
 * The model does not always write the gap's `name` exactly as it wrote the
 * timeline entry's `name`, despite the prompt asking it to. Observed drift:
 *   timeline: "Andosin tribe (pre-Roman)"   gap: "Andosin tribe"
 *   timeline: "Norse/Viking culture"        gap: "Norse / Viking culture"
 *
 * So we normalise before comparing: drop parenthesised qualifiers, lowercase,
 * collapse punctuation and whitespace. This absorbs typographic noise WITHOUT
 * creating false positives — "Norse culture" still does not match "Germanic
 * culture". The comparison stays an equality test on the normalised form, never
 * a fuzzy or partial match.
 */
function normaliseName(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ") // drop "(pre-Roman)", "(Jurchen)" …
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // punctuation, slashes, dashes → space
    .trim()
    .replace(/\s+/g, " ");
}

// ── Recording: write missing_entities from an extraction ──────────────────────

export type MissingEntity = {
  kind: string;
  name: string;
  context?: string;
  proposed_qid?: string; // canonical: the LLM's QID hypothesis, to be verified
  wikidata?: string; // tolerated aliases (older prompts / model drift)
  qid?: string;
};

/**
 * Record the missing entities signaled by one extraction.
 * Deduplicates by (kind, name): if the gap already exists, the site is appended
 * to site_ids and last_seen_at is bumped.
 *
 * SPURIOUS GAPS ARE FILTERED OUT. The model sometimes flags an entity it has
 * ALREADY resolved correctly in the timeline (out of retrospective doubt, e.g.
 * signalling "Kingdom of Denmark" as missing while the timeline entry carries a
 * perfectly good QID). Those are noise: if the timeline entry of that kind+name
 * already has a `wikidata` field, the entity is not missing and we skip it.
 *
 * WE ALSO CAPTURE THE ENTRY THAT PRODUCED THE GAP.
 *
 * The model's `context` is a gloss — a sentence about the entity. What a human
 * actually needs in order to arbitrate is the ENTRY: its period, its role, its
 * confidence, the source phrases it cites. "Insubres, on Milan" cannot be
 * decided; "Insubres, on Milan, -590 to -222, medium confidence, with this
 * source" is decided in ten seconds.
 *
 * Stored as an array because the same gap is signalled by several sites, each
 * with its own period — and the periods are often what reveals that two sites
 * mean different things by the same name.
 */
export async function recordGaps(
  sql: Sql<any>,
  siteId: string,
  missing: MissingEntity[] | undefined,
  timeline?: any,
): Promise<number> {
  if (!missing?.length) return 0;

  // Build the set of (kind, name) that the timeline ALREADY resolves with a QID.
  const alreadyResolved = new Set<string>();
  if (timeline) {
    for (const track of ["religion", "language", "polity", "culture"]) {
      const entries = timeline?.[track]?.entries;
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        const v = e?.value;
        if (v?.wikidata && typeof v?.name === "string") {
          alreadyResolved.add(`${track}::${normaliseName(v.name)}`);
        }
      }
    }
  }

  let recorded = 0;
  for (const m of missing) {
    if (!m?.kind || !m?.name) continue;
    if (!["religion", "language", "polity", "culture"].includes(m.kind))
      continue;

    // Skip: the timeline already carries a QID for this exact entity.
    if (alreadyResolved.has(`${m.kind}::${normaliseName(m.name)}`)) {
      console.log(
        `[gaps] skipping spurious gap: ${m.kind} "${m.name}" — already resolved in timeline`,
      );
      continue;
    }

    // The model sometimes emits the STRING "null" (or "none", or a malformed
    // value) rather than omitting the field. Coerce anything that is not a
    // well-formed QID to a real null, so we never store junk as a proposal.
    const raw = m.proposed_qid ?? m.wikidata ?? m.qid ?? null;
    const proposedQid =
      typeof raw === "string" && /^Q\d+$/.test(raw.trim()) ? raw.trim() : null;

    // Find the timeline entry that produced this gap. normaliseName() absorbs the
    // drift the model shows between the two ("Norse/Viking culture" in the track,
    // "Norse / Viking culture" in the gap) without ever matching two real entities.
    const entries = timeline?.[m.kind]?.entries;
    const hit = Array.isArray(entries)
      ? entries.find(
          (e: any) =>
            typeof e?.value?.name === "string" &&
            normaliseName(e.value.name) === normaliseName(m.name),
        )
      : undefined;

    const occurrence = {
      site_id: siteId,
      from: hit?.from ?? null,
      to: hit?.to ?? null,
      role: hit?.role ?? null,
      confidence: hit?.confidence ?? null,
      notes: hit?.notes ?? null,
      sources: Array.isArray(hit?.sources) ? hit.sources : [],
    };

    await sql`
      INSERT INTO referential_gaps
        (kind, name, context, proposed_qid, site_ids, occurrences)
      VALUES (
        ${m.kind},
        ${m.name},
        ${m.context ?? null},
        ${proposedQid},
        ARRAY[${siteId}]::text[],
        ${sql.json([occurrence])}::JSONB
      )
      ON CONFLICT (kind, name) DO UPDATE SET
        site_ids = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(referential_gaps.site_ids || ARRAY[${siteId}]::text[])
          )
        ),
        -- Replace this site's occurrence rather than append: a re-extraction
        -- produces a NEW entry for the same site, and stacking them would show a
        -- history of our own runs instead of the current state of the timeline.
        occurrences = (
          SELECT COALESCE(jsonb_agg(o), '[]'::JSONB)
          FROM jsonb_array_elements(referential_gaps.occurrences) o
          WHERE o->>'site_id' <> ${siteId}
        ) || ${sql.json([occurrence])}::JSONB,
        context = COALESCE(referential_gaps.context, EXCLUDED.context),
        proposed_qid = COALESCE(referential_gaps.proposed_qid, EXCLUDED.proposed_qid),
        last_seen_at = now()
      WHERE referential_gaps.status = 'pending'
    `;
    recorded++;
  }

  return recorded;
}

// ── Verification: is this QID actually the entity we think it is? ─────────────

export type VerificationResult = {
  ok: boolean;
  qid: string;
  label?: string;
  description?: string;
  reason?: string;
};

/**
 * Verify a QID against Wikidata: does it exist, is it the right type, does the
 * label plausibly match the name we're looking for?
 */
export async function verifyQid(
  qid: string,
  kind: string,
  expectedName: string,
): Promise<VerificationResult> {
  if (!/^Q\d+$/.test(qid)) {
    return { ok: false, qid, reason: "malformed QID" };
  }

  const url =
    `${WIKIDATA_API}?action=wbgetentities&format=json` +
    `&props=labels|descriptions|claims&languages=en&ids=${qid}`;

  let data: any;
  try {
    data = await wikiFetchJson(url);
  } catch (err: any) {
    return { ok: false, qid, reason: `fetch failed: ${err?.message ?? err}` };
  }

  const entity = data?.entities?.[qid];
  if (!entity || entity.missing !== undefined) {
    return {
      ok: false,
      qid,
      reason: "QID does not exist on Wikidata (hallucinated)",
    };
  }

  const label = entity.labels?.en?.value ?? "";
  const description = entity.descriptions?.en?.value ?? "";

  // Type check: gather P31 (instance of) and P279 (subclass of) targets.
  const typeQids = new Set<string>();
  for (const prop of ["P31", "P279"]) {
    const claims = entity.claims?.[prop] ?? [];
    for (const c of claims) {
      const id = c?.mainsnak?.datavalue?.value?.id;
      if (id) typeQids.add(id);
    }
  }

  const roots = EXPECTED_ROOTS[kind] ?? [];
  const directMatch = roots.some((r) => typeQids.has(r));

  // If no direct match, we can't cheaply walk the full P279* chain here — but a
  // description mentioning the kind is decent supporting evidence. We stay
  // conservative: a false negative costs a manual review; a false positive
  // pollutes the referential.
  const descMentionsKind = new RegExp(kind, "i").test(description);

  if (!directMatch && !descMentionsKind) {
    return {
      ok: false,
      qid,
      label,
      description,
      reason: `type mismatch: expected a ${kind}, got "${description || "no description"}"`,
    };
  }

  // Label sanity: the label should share some substance with the expected name.
  // Lenient (the LLM's name may be a variant), but a total mismatch is a red flag.
  const a = normaliseName(label).replace(/ /g, "");
  const b = normaliseName(expectedName).replace(/ /g, "");
  const labelPlausible =
    a.length > 0 &&
    (a.includes(b) ||
      b.includes(a) ||
      sharesSignificantToken(label, expectedName));

  if (!labelPlausible) {
    return {
      ok: false,
      qid,
      label,
      description,
      reason: `label mismatch: QID is "${label}", expected something like "${expectedName}"`,
    };
  }

  return { ok: true, qid, label, description };
}

function sharesSignificantToken(a: string, b: string): boolean {
  const tokens = (s: string) =>
    normaliseName(s)
      .split(" ")
      .filter((t) => t.length >= 4); // ignore short words like "of", "the"
  const ta = new Set(tokens(a));
  return tokens(b).some((t) => ta.has(t));
}

// ── Backfill: inject a resolved QID into every site that signaled the gap ─────

/**
 * For each site in site_ids, find timeline entries of the given kind whose
 * value.name matches `name` and which have no value.wikidata, and inject the QID.
 * Pure JSONB surgery — no LLM, no re-extraction.
 */
export async function backfillSites(
  sql: Sql<any>,
  kind: string,
  name: string,
  qid: string,
  siteIds: string[],
): Promise<number> {
  if (!siteIds.length) return 0;

  const target = normaliseName(name);
  let patched = 0;

  for (const siteId of siteIds) {
    const rows = await sql`
      SELECT timeline FROM sites WHERE id = ${siteId} AND timeline IS NOT NULL
    `;
    if (!rows.length) continue;

    const timeline =
      typeof rows[0].timeline === "string"
        ? JSON.parse(rows[0].timeline)
        : rows[0].timeline;

    const entries = timeline?.[kind]?.entries;
    if (!Array.isArray(entries)) continue;

    let changed = false;
    for (const e of entries) {
      const v = e?.value;
      if (!v || typeof v !== "object") continue;
      if (v.wikidata) continue; // already resolved — never overwrite
      if (typeof v.name !== "string") continue;
      if (normaliseName(v.name) !== target) continue; // the join key
      v.wikidata = qid;
      changed = true;
    }

    if (changed) {
      await sql`
        UPDATE sites
        SET timeline = ${sql.json(timeline)},
            last_updated = now()
        WHERE id = ${siteId}
      `;
      patched++;
    }
  }

  return patched;
}

// ── Resolution: verify + insert + backfill, in one deterministic pass ─────────

export type ResolutionOutcome = {
  gapId: number;
  kind: string;
  name: string;
  action: "resolved" | "needs_review";
  qid?: string;
  label?: string;
  sitesPatched?: number;
  reason?: string;
};

/**
 * Attempt to auto-resolve all pending gaps that carry a proposed QID.
 * Verified QIDs are inserted into wikidata_entities and backfilled into sites.
 * Unverifiable ones are left pending for human review.
 *
 * @param dryRun if true, verify and report but write nothing.
 */
export async function autoResolveGaps(
  sql: Sql<any>,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<ResolutionOutcome[]> {
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? 200;

  const gaps = await sql`
    SELECT id, kind, name, context, proposed_qid, site_ids
    FROM referential_gaps
    WHERE status = 'pending'
    ORDER BY array_length(site_ids, 1) DESC NULLS LAST, first_seen_at
    LIMIT ${limit}
  `;

  const outcomes: ResolutionOutcome[] = [];

  for (const gap of gaps) {
    const { id, kind, name, proposed_qid, site_ids } = gap as any;

    // No proposed QID → straight to human review.
    if (!proposed_qid) {
      outcomes.push({
        gapId: Number(id),
        kind,
        name,
        action: "needs_review",
        reason: "no QID proposed by the model",
      });
      continue;
    }

    // Already in the referential under that QID? Then just backfill.
    const existing = await sql`
      SELECT qid, label_en FROM wikidata_entities
      WHERE qid = ${proposed_qid} AND kind = ${kind}
    `;

    let verified: VerificationResult;
    if (existing.length) {
      verified = {
        ok: true,
        qid: proposed_qid,
        label: existing[0].label_en,
        description: "(already in referential)",
      };
    } else {
      verified = await verifyQid(proposed_qid, kind, name);
    }

    if (!verified.ok) {
      outcomes.push({
        gapId: Number(id),
        kind,
        name,
        action: "needs_review",
        qid: proposed_qid,
        reason: verified.reason,
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        gapId: Number(id),
        kind,
        name,
        action: "resolved",
        qid: verified.qid,
        label: verified.label,
        sitesPatched: (site_ids as string[])?.length ?? 0,
        reason: "(dry-run — nothing written)",
      });
      continue;
    }

    // Insert into the referential (if not already there).
    if (!existing.length) {
      await sql`
        INSERT INTO wikidata_entities
          (qid, kind, label_en, description_en, search_text, source_class)
        VALUES (
          ${verified.qid},
          ${kind},
          ${verified.label ?? name},
          ${verified.description ?? null},
          ${name},
          'auto-discovered'
        )
        ON CONFLICT (qid) DO NOTHING
      `;
    }

    // Backfill every site that signaled this gap.
    const patched = await backfillSites(
      sql,
      kind,
      name,
      verified.qid,
      (site_ids as string[]) ?? [],
    );

    // Enrichir le référentiel CRÉE du travail de bornes :
    //  - l'entité vient d'entrer, elle n'a pas de bornes ;
    //  - backfillSites vient d'injecter son QID dans des entrées qui n'avaient
    //    qu'un nom — elles deviennent bornables pour la première fois.
    const boundsSync = await syncBoundsForNewEntity(
      sql,
      verified.qid,
      (site_ids as string[]) ?? [],
    );

    await sql`
      UPDATE referential_gaps SET
        status = 'resolved',
        resolved_qid = ${verified.qid},
        resolved_at = now(),
        resolution_note = ${`auto-verified; ${patched} site(s) backfilled; ${boundsSync.bounded ? "bounded" : "no bounds on Wikidata"}, ${boundsSync.sitesChanged} site(s) re-bounded`}
      WHERE id = ${id}
    `;

    outcomes.push({
      gapId: Number(id),
      kind,
      name,
      action: "resolved",
      qid: verified.qid,
      label: verified.label,
      sitesPatched: patched,
    });
  }

  return outcomes;
}

/**
 * Manually resolve a gap with a human-supplied QID (used by the back-office).
 * Verifies, inserts, backfills, marks resolved.
 */
export async function resolveGapManually(
  sql: Sql<any>,
  gapId: number,
  qid: string,
  familyLabel?: string,
): Promise<ResolutionOutcome> {
  const rows = await sql`
    SELECT id, kind, name, site_ids FROM referential_gaps WHERE id = ${gapId}
  `;
  if (!rows.length) throw new Error(`Gap ${gapId} not found`);

  const { kind, name, site_ids } = rows[0] as any;

  const verified = await verifyQid(qid, kind, name);
  if (!verified.ok) {
    // Human override: record it anyway, but flag the discrepancy.
    // The human may well know better than our heuristic.
    console.warn(
      `[gaps] manual QID ${qid} failed verification (${verified.reason}) — inserting on human authority`,
    );
  }

  await sql`
    INSERT INTO wikidata_entities
      (qid, kind, label_en, description_en, search_text, family_label, source_class)
    VALUES (
      ${qid},
      ${kind},
      ${verified.label ?? name},
      ${verified.description ?? null},
      ${name},
      ${familyLabel ?? null},
      'human-resolved'
    )
    ON CONFLICT (qid) DO UPDATE SET
      kind = EXCLUDED.kind,
      family_label = COALESCE(EXCLUDED.family_label, wikidata_entities.family_label)
  `;

  const patched = await backfillSites(
    sql,
    kind,
    name,
    qid,
    (site_ids as string[]) ?? [],
  );

  // Enrichir le référentiel CRÉE du travail de bornes :
  //  - l'entité vient d'entrer, elle n'a pas de bornes ;
  //  - backfillSites vient d'injecter son QID dans des entrées qui n'avaient
  //    qu'un nom — elles deviennent bornables pour la première fois.
  const boundsSync = await syncBoundsForNewEntity(
    sql,
    qid,
    (site_ids as string[]) ?? [],
  );

  await sql`
    UPDATE referential_gaps SET
      status = 'resolved',
      resolved_qid = ${qid},
      resolved_at = now(),
      resolution_note = ${`auto-verified; ${patched} site(s) backfilled; ${boundsSync.bounded ? "bounded" : "no bounds on Wikidata"}, ${boundsSync.sitesChanged} site(s) re-bounded`}
    WHERE id = ${gapId}
  `;

  return {
    gapId,
    kind,
    name,
    action: "resolved",
    qid,
    label: verified.label,
    sitesPatched: patched,
  };
}

/**
 * Mark a gap as rejected (not a real entity, or not worth referencing).
 */
export async function rejectGap(
  sql: Sql<any>,
  gapId: number,
  note?: string,
): Promise<void> {
  await sql`
    UPDATE referential_gaps SET
      status = 'rejected',
      resolved_at = now(),
      resolution_note = ${note ?? "rejected — not worth referencing"}
    WHERE id = ${gapId}
  `;
}
