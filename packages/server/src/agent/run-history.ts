// packages/server/src/agent/run-history.ts
// =============================================================================
// Run history — records every extraction run and archives every prompt version.
//
// Nothing here is CONSUMED yet: `sites.timeline` is still written by the existing
// code (last run wins). This module only accumulates the corpus we need before
// designing a consolidator — so that its thresholds and matching rules come from
// measured variance rather than from guesswork.
//
// Design note. The prompt stays in the REPO (git is the source of truth); this is
// a LOG, not a source. It archives what actually ran, the way a deployment log
// records what was shipped.
// =============================================================================

import { createHash } from "node:crypto";
import type { Sql } from "postgres";

export function hashText(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/**
 * Hash of the REFERENTIAL as the model saw it.
 *
 * A richer referential changes the model's behaviour — that is the point of
 * filling it. So a run is only strictly comparable to another that saw the same
 * one. Without this, "our coverage improved" and "the model varied" would be
 * indistinguishable in the data.
 *
 * We hash the rendered referential blocks themselves: they ARE what went into the
 * prompt, so any change to them (a new QID, a changed label) shows up.
 */
export function referentialHash(refs: {
  religions: string;
  languages: string;
  polities: string;
  cultures: string;
}): string {
  return hashText(
    [refs.religions, refs.languages, refs.polities, refs.cultures].join("\n--\n"),
  );
}

/**
 * Archive a prompt template if we have not seen this hash before, and bump its
 * counters. Idempotent and cheap — safe to call on every extraction.
 *
 * The template passed here MUST be the raw one, with its {{markers}} intact. An
 * instantiated prompt embeds the site's Wikipedia context and would produce a
 * different hash for every site, making the history worthless.
 */
export async function recordPromptVersion(
  sql: Sql<any>,
  kind: string,
  template: string,
): Promise<string> {
  const hash = hashText(template);

  await sql`
    INSERT INTO prompt_versions (hash, kind, template, run_count)
    VALUES (${hash}, ${kind}, ${template}, 1)
    ON CONFLICT (hash) DO UPDATE SET
      last_seen_at = now(),
      run_count    = prompt_versions.run_count + 1
  `;

  return hash;
}

export type RunRecord = {
  siteId: string;
  timeline: any;
  model: string;
  promptHash: string;
  referentialHash?: string;
  localLang?: string | null;
  qidViolations?: number;
  rejected?: boolean;
  rejectionReason?: string | null;
  /** Did a human validate this run? False for previews and batch runs. */
  confirmed?: boolean;
};

/**
 * Record one extraction run.
 *
 * Rejected and unconfirmed runs are kept deliberately: a run the human threw away
 * is often a bad one, and bad runs are precisely the samples that characterise the
 * failure modes. `confirmed` records the verdict without discarding the evidence.
 *
 * Never throws into the caller's path: an extraction must not fail because its
 * bookkeeping failed.
 */
export async function recordRun(
  sql: Sql<any>,
  r: RunRecord,
): Promise<number | null> {
  try {
    const rows = await sql`
      INSERT INTO site_extractions (
        site_id, timeline, model, prompt_hash, referential_hash,
        local_lang, qid_violations, rejected, rejection_reason, confirmed
      ) VALUES (
        ${r.siteId},
        ${sql.json(r.timeline)},
        ${r.model},
        ${r.promptHash},
        ${r.referentialHash ?? null},
        ${r.localLang ?? null},
        ${r.qidViolations ?? 0},
        ${r.rejected ?? false},
        ${r.rejectionReason ?? null},
        ${r.confirmed ?? false}
      )
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error("[run-history] failed to record run:", err);
    return null;
  }
}

/** Mark a previously recorded run as human-confirmed. */
export async function confirmRun(
  sql: Sql<any>,
  runId: number,
): Promise<void> {
  try {
    await sql`UPDATE site_extractions SET confirmed = true WHERE id = ${runId}`;
  } catch (err) {
    console.error("[run-history] failed to confirm run:", err);
  }
}
