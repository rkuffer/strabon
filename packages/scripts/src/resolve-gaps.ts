// packages/scripts/src/resolve-gaps.ts
// =============================================================================
// CLI for the referential-gaps loop.
//
//   list                        show pending gaps (most-signaled first)
//   auto [--execute]            auto-resolve gaps with a verifiable proposed QID
//                               (dry-run by default)
//   resolve <gapId> <QID> [family]   manually resolve one gap
//   reject <gapId> [note]       mark a gap as not worth referencing
//
// Usage:
//   DATABASE_URL=... npx tsx packages/scripts/src/resolve-gaps.ts list
//   DATABASE_URL=... npx tsx packages/scripts/src/resolve-gaps.ts auto
//   DATABASE_URL=... npx tsx packages/scripts/src/resolve-gaps.ts auto --execute
//   DATABASE_URL=... npx tsx packages/scripts/src/resolve-gaps.ts resolve 3 Q486761 "Eurasian/Steppe"
// =============================================================================

// # 1. Voir les gaps accumulés
// npx -y tsx packages/scripts/src/resolve-gaps.ts list

// # 2. Auto-résolution en dry-run — voir ce qui passerait la vérification
// npx -y tsx packages/scripts/src/resolve-gaps.ts auto

// # 3. Appliquer
// npx -y tsx packages/scripts/src/resolve-gaps.ts auto --execute

// # 4. Les cas qui ont échoué : résolution manuelle (tu fournis le bon QID)
// npx -y tsx packages/scripts/src/resolve-gaps.ts resolve 3 Q486761 "Eurasian/Steppe"

// # 5. Ou rejet, si l'entité ne mérite pas d'entrer au référentiel
// npx -y tsx packages/scripts/src/resolve-gaps.ts reject 7 "minor local tribe"

import { getSql, closeSql } from "@strabon/db";
import {
  autoResolveGaps,
  resolveGapManually,
  rejectGap,
} from "@strabon/db";

async function list(sql: any) {
  const gaps = await sql`
    SELECT id, kind, name, context, proposed_qid, site_ids, status,
           array_length(site_ids, 1) AS site_count
    FROM referential_gaps
    WHERE status = 'pending'
    ORDER BY array_length(site_ids, 1) DESC NULLS LAST, first_seen_at
  `;

  if (!gaps.length) {
    console.log("\nNo pending gaps.\n");
    return;
  }

  console.log(`\n=== ${gaps.length} pending gap(s) ===\n`);
  for (const g of gaps) {
    const qid = g.proposed_qid
      ? ` → proposed ${g.proposed_qid}`
      : " → no QID proposed";
    console.log(`  [${g.id}] (${g.kind}) ${g.name}${qid}`);
    console.log(
      `       signaled by ${g.site_count ?? 0} site(s): ${(g.site_ids ?? []).slice(0, 5).join(", ")}${(g.site_ids ?? []).length > 5 ? "…" : ""}`,
    );
    if (g.context) console.log(`       context: ${g.context}`);
    console.log();
  }

  const byKind = await sql`
    SELECT kind, COUNT(*)::int AS n
    FROM referential_gaps WHERE status = 'pending'
    GROUP BY kind ORDER BY n DESC
  `;
  console.log(
    "  by kind: " +
      byKind.map((r: any) => `${r.kind}=${r.n}`).join(", ") +
      "\n",
  );
}

async function auto(sql: any, execute: boolean) {
  console.log(
    `\n=== Auto-resolving gaps — ${execute ? "EXECUTE" : "DRY-RUN"} ===\n`,
  );

  const outcomes = await autoResolveGaps(sql, { dryRun: !execute });

  const resolved = outcomes.filter((o) => o.action === "resolved");
  const review = outcomes.filter((o) => o.action === "needs_review");

  if (resolved.length) {
    console.log(`── RESOLVED (${resolved.length}) ──`);
    for (const o of resolved) {
      console.log(
        `  ✓ [${o.gapId}] (${o.kind}) ${o.name} → ${o.qid} "${o.label ?? ""}"` +
          (o.sitesPatched != null
            ? `  — ${o.sitesPatched} site(s) backfilled`
            : ""),
      );
    }
    console.log();
  }

  if (review.length) {
    console.log(`── NEEDS HUMAN REVIEW (${review.length}) ──`);
    for (const o of review) {
      console.log(`  ✗ [${o.gapId}] (${o.kind}) ${o.name}`);
      console.log(`       ${o.qid ? `proposed ${o.qid} — ` : ""}${o.reason}`);
    }
    console.log();
  }

  if (!execute && resolved.length) {
    console.log("  (dry-run — re-run with --execute to apply)\n");
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const sql = getSql();

  try {
    switch (cmd) {
      case "list":
        await list(sql);
        break;

      case "auto":
        await auto(sql, args.includes("--execute"));
        break;

      case "resolve": {
        const gapId = parseInt(args[0], 10);
        const qid = args[1];
        const family = args[2];
        if (!gapId || !qid) {
          console.error(
            "Usage: resolve-gaps.ts resolve <gapId> <QID> [family]",
          );
          process.exit(1);
        }
        const out = await resolveGapManually(sql, gapId, qid, family);
        console.log(
          `\n  ✓ [${out.gapId}] (${out.kind}) ${out.name} → ${out.qid}` +
            `  — ${out.sitesPatched} site(s) backfilled\n`,
        );
        break;
      }

      case "reject": {
        const gapId = parseInt(args[0], 10);
        if (!gapId) {
          console.error("Usage: resolve-gaps.ts reject <gapId> [note]");
          process.exit(1);
        }
        await rejectGap(sql, gapId, args.slice(1).join(" ") || undefined);
        console.log(`\n  ✓ gap ${gapId} rejected\n`);
        break;
      }

      default:
        console.error(
          "Commands: list | auto [--execute] | resolve <gapId> <QID> [family] | reject <gapId> [note]",
        );
        process.exit(1);
    }
  } finally {
    await closeSql();
  }
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
