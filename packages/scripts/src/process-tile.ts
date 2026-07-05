// packages/scripts/src/process-tile.ts
// =============================================================================
// CLI harness: process a single 1° tile (SPARQL → sites L0).
// Dry-run by default (shows what it would write). Pass --execute to write.
//
// Usage:
//   DATABASE_URL=... npx tsx packages/scripts/src/process-tile.ts 38 37
//   DATABASE_URL=... npx tsx packages/scripts/src/process-tile.ts 0 44 --execute
// =============================================================================

import { processTile } from "../../server/src/agent/tile-processor.js";
import { closeSql } from "@strabon/db";

async function main() {
  const args = process.argv.slice(2);
  const nums = args.filter((a) => !a.startsWith("--")).map(Number);
  const execute = args.includes("--execute");

  if (nums.length < 2 || isNaN(nums[0]) || isNaN(nums[1])) {
    console.error("Usage: process-tile.ts <lon_min> <lat_min> [--execute]");
    process.exit(1);
  }

  const [lonMin, latMin] = nums;
  console.log(`\n=== Processing tile (${lonMin}, ${latMin}) — ${execute ? "EXECUTE" : "DRY-RUN"} ===\n`);

  const t0 = Date.now();
  const result = await processTile(lonMin, latMin, { dryRun: !execute });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== ${result.sites.length} sites (${result.new_count} new, ${result.existing_count} existing) — ${secs}s ===\n`);

  // Display the list, sorted by sitelinks_count descending (most important first).
  const sorted = [...result.sites].sort(
    (a, b) => (b.sitelinks_count ?? 0) - (a.sitelinks_count ?? 0),
  );

  for (const s of sorted) {
    const flag = s.already_in_db ? "  [ALREADY IN DB]" : "";
    const sl = s.sitelinks_count != null ? `  sl:${s.sitelinks_count}` : "";
    const pop = s.population != null ? `  pop:${s.population.toLocaleString()}` : "";
    console.log(`  ${s.qid.padEnd(12)} ${s.label}${flag}${sl}${pop}`);
    if (s.description) console.log(`    ↳ ${s.description}`);
  }

  console.log(
    `\n  executed: ${result.executed}${result.dryRun ? " (dry-run — nothing written)" : ""}\n`,
  );

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
