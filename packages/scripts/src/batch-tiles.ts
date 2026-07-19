// packages/scripts/src/batch-tiles.ts
// =============================================================================
// Batch indexation: process ALL pending tiles, one by one.
// Reports progress, handles errors per-tile (marks failed tiles, continues).
//
// Usage:
//   DATABASE_URL=... npx tsx packages/scripts/src/batch-tiles.ts
//   DATABASE_URL=... npx tsx packages/scripts/src/batch-tiles.ts --limit 100   (process at most N tiles)
//   DATABASE_URL=... npx tsx packages/scripts/src/batch-tiles.ts --dry-run     (no writes)
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { processTile } from "./tile-processor.js";

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitStr = argValue(args, "--limit");
  const limit = limitStr ? parseInt(limitStr, 10) : null;

  const sql = getSql();

  // Count pending tiles.
  const [{ count: totalPending }] = await sql`
    SELECT COUNT(*) AS count FROM tiles WHERE status = 'pending'
  `;
  const target = limit ? Math.min(limit, Number(totalPending)) : Number(totalPending);
  console.log(`\n=== Batch indexation: ${target} tiles to process (${totalPending} total pending) ===`);
  console.log(`    mode: ${dryRun ? "DRY-RUN" : "EXECUTE"}\n`);

  let processed = 0;
  let totalSites = 0;
  let totalNew = 0;
  let errors = 0;
  const t0 = Date.now();

  while (processed < target) {
    // Pick the next pending tile. Lock it by marking 'processing'.
    const rows = await sql`
      UPDATE tiles
      SET status = 'processing'
      WHERE (lon_min, lat_min) = (
        SELECT lon_min, lat_min FROM tiles
        WHERE status = 'pending'
        ORDER BY lat_min DESC, lon_min ASC
        LIMIT 1
      )
      RETURNING lon_min, lat_min
    `;

    if (rows.length === 0) {
      console.log("\n[batch] No more pending tiles.");
      break;
    }

    const { lon_min, lat_min } = rows[0];
    processed++;

    try {
      const result = await processTile(
        Number(lon_min),
        Number(lat_min),
        { dryRun, verbose: false },
      );

      totalSites += result.sites.length;
      totalNew += result.new_count;

      // Progress line.
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (processed / ((Date.now() - t0) / 1000)).toFixed(1);
      const eta = limit
        ? ((target - processed) / parseFloat(rate)).toFixed(0)
        : "?";
      console.log(
        `  [${processed}/${target}] tile (${lon_min},${lat_min}): ` +
        `${result.sites.length} sites (${result.new_count} new) — ` +
        `${elapsed}s elapsed, ${rate} tiles/s, ETA ~${eta}s`,
      );

      if (dryRun) {
        // Revert the tile to pending (dry-run should not change state).
        await sql`
          UPDATE tiles SET status = 'pending'
          WHERE lon_min = ${lon_min} AND lat_min = ${lat_min}
        `;
      }
    } catch (err: any) {
      errors++;
      console.error(
        `  [${processed}/${target}] tile (${lon_min},${lat_min}): ` +
        `ERROR — ${err?.message ?? String(err)}`,
      );
      // Mark the tile back to pending so it can be retried later.
      // (We could mark it 'failed' but pending allows simple retry.)
      await sql`
        UPDATE tiles SET status = 'pending'
        WHERE lon_min = ${lon_min} AND lat_min = ${lat_min}
      `;
    }
  }

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Batch complete ===`);
  console.log(`  tiles processed: ${processed} (${errors} errors)`);
  console.log(`  sites found: ${totalSites} (${totalNew} new)`);
  console.log(`  elapsed: ${totalElapsed}s`);
  if (processed > 0) {
    console.log(`  avg: ${(parseFloat(totalElapsed) / processed).toFixed(1)}s/tile`);
  }

  await closeSql();
}

main().catch((err) => {
  console.error("BATCH FAILED:", err?.message ?? err);
  process.exit(1);
});
