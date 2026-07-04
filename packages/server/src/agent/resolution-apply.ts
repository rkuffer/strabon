// packages/server/src/agent/resolution-apply.ts
// =============================================================================
// Resolution — verdict application (THE ONLY WRITE PATH of the agent pipeline).
//
// The Resolution agent (resolution-agent.ts) only READS and JUDGES. This module
// is the sole component that WRITES: it turns a verdict into database effects.
// Keeping it physically separate makes the read/write frontier a structural
// guarantee, not just a convention.
//
//   applyVerdict(candidateId, verdict, { dryRun }) → ApplyPlan
//
// dryRun=true  → computes and returns the plan, writes NOTHING.
// dryRun=false → executes the plan in a transaction.
//
// Verdict → effect:
//   single      → upsert 1 minimal site; candidate → resolved(+produced_site_ids)
//   split       → upsert 2 linked sites (relation_note + related_qid in meta);
//                 candidate → resolved(+both QIDs)
//   duplicate   → no site; candidate → duplicate(+note)
//   rejected    → no site; candidate → rejected(+reason)
//   needs_human → candidate → awaiting_human(+question/options)
// =============================================================================

import { getSql, upsertSite } from "@strabon/db";
import type { ResolutionVerdict } from "./resolution-agent.js";

// ── Plan (what applyVerdict will do / did) ────────────────────────────────────

export type SiteWrite = {
  id: string;
  wikidata_id: string;
  title_en: string;
  lat?: number | null;
  lon?: number | null;
  country_qid?: string | null;
  meta?: Record<string, unknown>;
};

export type CandidateUpdate = {
  status: string;
  produced_site_ids?: string[];
  resolution_notes?: string | null;
  human_question?: string | null;
  human_answer?: null; // never set here
};

export type ApplyPlan = {
  candidateId: number;
  verdict: ResolutionVerdict["verdict"];
  siteWrites: SiteWrite[]; // sites to upsert (0, 1 or 2)
  candidateUpdate: CandidateUpdate;
  warnings: string[]; // e.g. "QID already in sites"
  dryRun: boolean;
  executed: boolean;
};

// ── Coercion helpers (defensive against model scories) ────────────────────────

// The model sometimes emits the STRING "null" for an omitted value. Treat it,
// and empty strings, as genuine null. (Pending prompt fix will reduce this.)
function cleanStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" || s.toLowerCase() === "null" ? null : s;
}

// ── Plan builders per verdict ─────────────────────────────────────────────────

function buildPlan(
  candidateId: number,
  v: ResolutionVerdict,
): {
  siteWrites: SiteWrite[];
  candidateUpdate: CandidateUpdate;
  warnings: string[];
} {
  const warnings: string[] = [];

  switch (v.verdict) {
    case "single": {
      const qid = cleanStr(v.qid);
      const title = cleanStr(v.title);
      if (!qid || !title) {
        throw new Error(
          `single verdict missing qid/title (got qid=${v.qid}, title=${v.title})`,
        );
      }
      return {
        siteWrites: [
          {
            id: qid,
            wikidata_id: qid,
            title_en: title,
            lat: v.lat ?? null,
            lon: v.lon ?? null,
            country_qid: cleanStr(v.country_qid),
          },
        ],
        candidateUpdate: {
          status: "resolved",
          produced_site_ids: [qid],
          resolution_notes: cleanStr(v.reasoning),
        },
      };
    }

    case "split": {
      const sites = v.sites ?? [];
      if (sites.length !== 2) {
        throw new Error(
          `split verdict must carry exactly 2 sites (got ${sites.length})`,
        );
      }
      const note = cleanStr(v.relation_note);
      const [ancient, modern] = sites;
      const aQid = cleanStr(ancient.qid);
      const mQid = cleanStr(modern.qid);
      if (!aQid || !mQid)
        throw new Error("split verdict has a site without a QID");

      // relation_note stored on both, plus related_qid pointing to the twin.
      const ancientMeta = {
        relation_note: note,
        related_qid: mQid,
        relation_role: "ancient",
      };
      const modernMeta = {
        relation_note: note,
        related_qid: aQid,
        relation_role: "modern",
      };

      return {
        siteWrites: [
          {
            id: aQid,
            wikidata_id: aQid,
            title_en: cleanStr(ancient.title) ?? aQid,
            lat: ancient.lat ?? null,
            lon: ancient.lon ?? null,
            country_qid: cleanStr((ancient as any).country_qid),
            meta: ancientMeta,
          },
          {
            id: mQid,
            wikidata_id: mQid,
            title_en: cleanStr(modern.title) ?? mQid,
            lat: modern.lat ?? null,
            lon: modern.lon ?? null,
            country_qid: cleanStr((modern as any).country_qid),
            meta: modernMeta,
          },
        ],
        candidateUpdate: {
          status: "resolved",
          produced_site_ids: [aQid, mQid],
          resolution_notes: cleanStr(v.reasoning),
        },
      };
    }

    case "duplicate": {
      const existing = cleanStr(v.existing_qid);
      const note = [
        cleanStr(v.reasoning),
        existing
          ? `Duplicate of ${existing} (${cleanStr(v.existing_title) ?? "?"}).`
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        siteWrites: [],
        candidateUpdate: {
          status: "duplicate",
          resolution_notes: note || null,
        },
      };
    }

    case "rejected": {
      const note = [cleanStr(v.reasoning), cleanStr(v.reason)]
        .filter(Boolean)
        .join(" — ");
      return {
        siteWrites: [],
        candidateUpdate: { status: "rejected", resolution_notes: note || null },
      };
    }

    case "needs_human": {
      const question = cleanStr(v.question);
      const opts = (v.options ?? [])
        .map((o) => cleanStr(o))
        .filter(Boolean) as string[];
      const fullQuestion = opts.length
        ? `${question}\nOptions: ${opts.join(" | ")}`
        : question;
      return {
        siteWrites: [],
        candidateUpdate: {
          status: "awaiting_human",
          human_question: fullQuestion,
          resolution_notes: cleanStr(v.reasoning),
        },
      };
    }

    default:
      throw new Error(`Unknown verdict: ${(v as any).verdict}`);
  }
}

// ── Warnings: surface silent conflicts (e.g. split whose QIDs already exist) ───

async function collectWarnings(siteWrites: SiteWrite[]): Promise<string[]> {
  if (siteWrites.length === 0) return [];
  const sql = getSql();
  const warnings: string[] = [];
  for (const w of siteWrites) {
    const rows = await sql`
      SELECT id, title_en FROM sites WHERE id = ${w.id} OR wikidata_id = ${w.id} LIMIT 1
    `;
    if (rows.length) {
      warnings.push(
        `QID ${w.id} already present in sites as "${rows[0].title_en}" — upsert will UPDATE it (verdict may have been better as duplicate).`,
      );
    }
  }
  return warnings;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function applyVerdict(
  candidateId: number,
  verdict: ResolutionVerdict,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyPlan> {
  const dryRun = opts.dryRun ?? false;
  const sql = getSql();

  const {
    siteWrites,
    candidateUpdate,
    warnings: buildWarnings = [],
  } = buildPlan(candidateId, verdict);
  const warnings = [...buildWarnings, ...(await collectWarnings(siteWrites))];

  const plan: ApplyPlan = {
    candidateId,
    verdict: verdict.verdict,
    siteWrites,
    candidateUpdate,
    warnings,
    dryRun,
    executed: false,
  };

  if (dryRun) return plan;

  // ── Execute ─────────────────────────────────────────────────────────────────
  // No wrapping transaction: upsertSite runs on its own handle and would not
  // enrol in it anyway. Instead we rely on IDEMPOTENCE for recovery — sites are
  // upserted (ON CONFLICT DO UPDATE), then the candidate is marked. A failure
  // between the two just means a re-run re-upserts identically and re-marks;
  // the candidate's status is the source of truth. Order matters: sites first,
  // candidate last, so a candidate is never marked 'resolved' without its sites.
  for (const w of siteWrites) {
    await upsertSite({
      id: w.id,
      wikidata_id: w.wikidata_id,
      title_en: w.title_en,
      lat: w.lat ?? undefined,
      lon: w.lon ?? undefined,
      country_qid: w.country_qid ?? undefined,
      meta: w.meta ?? undefined,
    });
  }

  await sql`
    UPDATE site_candidates SET
      status            = ${candidateUpdate.status},
      produced_site_ids = ${candidateUpdate.produced_site_ids ?? []},
      resolution_notes  = ${candidateUpdate.resolution_notes ?? null},
      human_question    = ${candidateUpdate.human_question ?? null},
      updated_at        = now()
    WHERE id = ${candidateId}
  `;

  plan.executed = true;
  return plan;
}
