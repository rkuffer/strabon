// packages/scripts/src/test-resolution-tools.ts
// =============================================================================
// CLI harness for the Resolution agent tools. Tests each tool in isolation,
// BEFORE any agent loop exists.
//
// Usage:
//   npx tsx packages/scripts/src/test-resolution-tools.ts search "Hacılar"
//   npx tsx packages/scripts/src/test-resolution-tools.ts entity Q10764506
//   npx tsx packages/scripts/src/test-resolution-tools.ts distance 37.94 22.87 37.906 22.879
//   DATABASE_URL=... npx tsx packages/scripts/src/test-resolution-tools.ts exists Q5687
//   npx tsx packages/scripts/src/test-resolution-tools.ts intro "Ancient Corinth"
// =============================================================================

import {
  searchWikidataSites,
  getWikidataEntity,
  geoDistance,
  checkSiteExists,
  getWikipediaIntro,
} from "../../server/src/agent/resolution-tools.js";
import { closeSql } from "@strabon/db";

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "search": {
      const results = await searchWikidataSites(args.join(" "));
      console.log(`\n${results.length} candidate(s) for "${args.join(" ")}"\n`);
      for (const r of results) {
        console.log(`  ${r.qid.padEnd(12)} ${r.label}`);
        if (r.description) console.log(`    ↳ ${r.description}`);
        if (r.types.length)
          console.log(`    types: ${r.types.map((t) => t.label).join(" | ")}`);
      }
      break;
    }

    case "entity": {
      const detail = await getWikidataEntity(args[0]);
      console.log(JSON.stringify(detail, null, 2));
      break;
    }

    case "distance": {
      const [latA, lonA, latB, lonB] = args.map(Number);
      console.log(geoDistance(latA, lonA, latB, lonB));
      break;
    }

    case "exists": {
      const result = await checkSiteExists(args[0]);
      console.log(JSON.stringify(result, null, 2));
      await closeSql();
      break;
    }

    case "intro": {
      const result = await getWikipediaIntro(args.join(" "));
      console.log(`\n== ${result.title} ==\n`);
      console.log(result.intro ?? "(page not found)");
      break;
    }

    default:
      console.error(
        "Usage: test-resolution-tools.ts <search|entity|distance|exists|intro> <args...>",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message ?? err);
  process.exit(1);
});
