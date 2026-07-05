// packages/scripts/src/test-discovery-agent.ts
// =============================================================================
// CLI harness for the Discovery agent. Runs the loop on a request and prints
// the PROPOSED candidate list. Writes NOTHING (the agent only proposes).
//
// Usage:
//   ANTHROPIC_API_KEY=... DATABASE_URL=... \
//     npx tsx packages/scripts/src/test-discovery-agent.ts "Marseille"
//   ... "Beyrouth"
//   ... "Aşıklı Höyük"
//   ... "Çatalhöyük"      (already in base → should appear greyed/flagged)
// =============================================================================

import { discoverCandidates } from "../../server/src/agent/discovery-agent.js";
import { closeSql } from "@strabon/db";

async function main() {
  const request = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");
  if (!request) {
    console.error('Usage: test-discovery-agent.ts "<request>"');
    process.exit(1);
  }

  console.log(`\n=== Discovery: "${request}" ===\n`);
  const t0 = Date.now();
  const result = await discoverCandidates(request);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== ${result.proposals.length} proposal(s) (${result.turns} turns, ${secs}s) ===\n`);
  for (const p of result.proposals) {
    const flag = p.already_in_base ? "  [IN BASE — greyed]" : "";
    const coords = p.lat != null && p.lon != null ? ` (${p.lat}, ${p.lon})` : "";
    console.log(`  ${p.qid.padEnd(12)} ${p.label}${flag}`);
    if (p.type) console.log(`    type: ${p.type}${coords}`);
    if (p.description) console.log(`    ↳ ${p.description}`);
  }
  console.log(`\nreasoning: ${result.reasoning}\n`);
  console.log(`tool calls: ${result.tool_calls.length}`);

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
