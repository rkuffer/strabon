// packages/scripts/src/test-resolution-apply.ts
// =============================================================================
// Full-chain harness: insert a test candidate → resolve it → apply the verdict.
// DEFAULTS TO DRY-RUN (writes nothing but the initial candidate row). Pass
// --execute to actually write the produced sites and mark the candidate.
//
// Usage:
//   ANTHROPIC_API_KEY=... DATABASE_URL=... \
//     npx tsx packages/scripts/src/test-resolution-apply.ts "Hacılar" --qid Q10764506 --intent "Neolithic sites of Anatolia"
//   ... "Marseille"
//   ... "Göbekli Tepe" --intent "Neolithic sites of Anatolia" --execute
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { resolveCandidate } from "../../server/src/agent/resolution-agent.js";
import { applyVerdict } from "../../server/src/agent/resolution-apply.js";

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const rawTitle = args.find(
    (a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")),
  );
  if (!rawTitle) {
    console.error(
      'Usage: test-resolution-apply.ts "<title>" [--qid Qxxx] [--intent "..."] [--execute]',
    );
    process.exit(1);
  }
  const wikidataId = argValue(args, "--qid");
  const intent = argValue(args, "--intent");
  const execute = args.includes("--execute");

  const sql = getSql();

  // 1. Insert a fresh test candidate.
  const inserted = await sql`
    INSERT INTO site_candidates (discovery_intent, raw_title, wikidata_id, status)
    VALUES (${intent}, ${rawTitle}, ${wikidataId}, 'discovered')
    RETURNING id
  `;
  const candidateId = Number(inserted[0].id);
  console.log(
    `\n[1] Inserted candidate #${candidateId}: "${rawTitle}"${wikidataId ? ` (qid=${wikidataId})` : ""}\n`,
  );

  // 2. Resolve.
  console.log(`[2] Resolving...\n`);
  const run = await resolveCandidate(
    { raw_title: rawTitle, wikidata_id: wikidataId, discovery_intent: intent },
    { verbose: true },
  );
  console.log(`\n    Verdict: ${run.verdict.verdict} (${run.turns} turns)`);
  console.log(`    ${JSON.stringify(run.verdict).slice(0, 300)}...\n`);

  // 3. Apply (dry-run unless --execute).
  console.log(`[3] Applying verdict (${execute ? "EXECUTE" : "DRY-RUN"})...\n`);
  const plan = await applyVerdict(candidateId, run.verdict, {
    dryRun: !execute,
  });

  console.log(
    `    Candidate #${plan.candidateId} → status "${plan.candidateUpdate.status}"`,
  );
  if (plan.candidateUpdate.produced_site_ids?.length)
    console.log(
      `    produced_site_ids: ${plan.candidateUpdate.produced_site_ids.join(", ")}`,
    );
  if (plan.siteWrites.length) {
    console.log(`    sites to upsert:`);
    for (const w of plan.siteWrites) {
      console.log(
        `      - ${w.id}  "${w.title_en}"  (${w.lat ?? "?"}, ${w.lon ?? "?"})  country=${w.country_qid ?? "—"}`,
      );
      if (w.meta) console.log(`        meta: ${JSON.stringify(w.meta)}`);
    }
  } else {
    console.log(`    (no site created)`);
  }
  if (plan.warnings.length) {
    console.log(`\n    ⚠ warnings:`);
    for (const wn of plan.warnings) console.log(`      - ${wn}`);
  }
  console.log(
    `\n    executed: ${plan.executed}${plan.dryRun ? " (dry-run — nothing written beyond the candidate row)" : ""}\n`,
  );

  if (!execute) {
    // Clean up the test candidate row so dry-runs don't accumulate.
    await sql`DELETE FROM site_candidates WHERE id = ${candidateId}`;
    console.log(
      `[cleanup] Removed test candidate #${candidateId} (dry-run).\n`,
    );
  }

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
