// packages/scripts/src/test-resolution-agent.ts
// =============================================================================
// CLI harness for the Resolution agent. Runs the full tool-use loop on ONE
// candidate and prints the verdict + audit trail. NOTHING is written to the
// database — the agent only reads.
//
// Usage:
//   ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx packages/scripts/src/test-resolution-agent.ts "Hacılar" --intent "Neolithic sites of Anatolia"
//   ... "Hacılar" --qid Q10764506 --intent "Neolithic sites of Anatolia"   (wrong-QID scenario)
//   ... "Byzantium"
//   ... "Corinth"
//   ... "Marseille"
// =============================================================================

import { resolveCandidate } from "../../server/src/agent/resolution-agent.js";
import { closeSql } from "@strabon/db";

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")),
  );
  const rawTitle = positional[0];
  if (!rawTitle) {
    console.error(
      'Usage: test-resolution-agent.ts "<title>" [--qid Qxxx] [--intent "..."]',
    );
    process.exit(1);
  }

  const candidate = {
    raw_title: rawTitle,
    wikidata_id: argValue(args, "--qid"),
    discovery_intent: argValue(args, "--intent"),
  };

  console.log(`\n=== Resolving: ${JSON.stringify(candidate)} ===\n`);
  const t0 = Date.now();
  const run = await resolveCandidate(candidate, { verbose: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Verdict (${run.turns} turns, ${secs}s) ===\n`);
  console.log(JSON.stringify(run.verdict, null, 2));
  console.log(`\nTool calls: ${run.tool_calls.length}`);

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
