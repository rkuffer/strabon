/**
 * Fills `sitelinks_count` on wikidata_entities from Wikidata.
 *
 * WHY
 * ---
 * The referential holds 4,435 polities. The extraction prompt injects ALL of them,
 * for every site — 538,000 characters to extract a Breton hamlet. And only ~200 are
 * actually used by any timeline.
 *
 * Sitelinks count (how many Wikipedia language editions have an article about the
 * entity) is the cheapest available proxy for notability, and it is the same signal
 * already used to prioritise SITES for extraction.
 *
 * THE BIAS, STATED PLAINLY
 * ------------------------
 * Sitelinks measure NOTABILITY ON WIKIPEDIA, not historical importance. The bias is
 * known and systematic: European and anglophone entities are over-represented;
 * African, Oceanian and South Asian polities are under-represented. A significant
 * Swahili kingdom will carry fewer sitelinks than a minuscule German principality.
 *
 * For an atlas that means to be WORLDWIDE, that is a real problem, not a footnote.
 * A sitelinks threshold will thin the referential exactly where it is already
 * thinnest. Whatever cut is chosen, it must be applied with that in mind — and
 * never to an entity a timeline already uses, or a gap already asks for.
 *
 * This script only MEASURES. It cuts nothing.
 *
 * Usage:
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/entity-sitelinks-sparql.ts
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/entity-sitelinks-sparql.ts --kind polity
 */

import postgres from "postgres";

const WDQS = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "Strabon/1.0 (historical atlas; contact via github.com/rkuffer/strabon)";

const BATCH_SIZE = 300;
const SPACING_MS = 1200;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KIND_FILTER = args.includes("--kind")
  ? args[args.indexOf("--kind") + 1]
  : null;
/** Refill entities that already have a count (they go stale). */
const REFRESH = args.includes("--refresh");

async function sparqlQuery(query: string): Promise<any[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(WDQS, {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: query,
    });

    if (res.status === 429 || res.status >= 500) {
      const wait = 2000 * 2 ** attempt;
      console.warn(`  ⚠ HTTP ${res.status} — retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`SPARQL ${res.status}: ${await res.text()}`);

    return ((await res.json()) as any).results.bindings;
  }
  throw new Error("SPARQL: exhausted retries");
}

/**
 * `wikibase:sitelinks` is a materialised property on the entity itself — one row
 * per entity, no statement nodes, no rank problem. Unlike the bounds query, there
 * is nothing subtle here.
 */
function buildQuery(qids: string[]): string {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  return `
SELECT ?e ?links WHERE {
  VALUES ?e { ${values} }
  ?e wikibase:sitelinks ?links .
}`;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  const targets = await sql<{ qid: string; kind: string }[]>`
    SELECT qid, kind
    FROM wikidata_entities
    WHERE TRUE
      AND active
      ${REFRESH ? sql`` : sql`AND sitelinks_count IS NULL`}
      ${KIND_FILTER ? sql`AND kind = ${KIND_FILTER}` : sql``}
    ORDER BY kind, qid
  `;

  console.log(
    `${targets.length} entities to measure${KIND_FILTER ? ` (kind=${KIND_FILTER})` : ""}`,
  );
  if (DRY_RUN) console.log("DRY RUN — nothing will be written\n");

  let written = 0;
  let missing = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const qids = batch.map((t) => t.qid);

    process.stdout.write(
      `[${i + 1}-${Math.min(i + BATCH_SIZE, targets.length)}/${targets.length}] `,
    );

    let rows: any[];
    try {
      rows = await sparqlQuery(buildQuery(qids));
    } catch (err: any) {
      console.error(`✗ batch failed: ${err.message}`);
      continue;
    }

    const counts = new Map<string, number>();
    for (const r of rows) {
      const qid = r.e.value.replace("http://www.wikidata.org/entity/", "");
      const n = parseInt(r.links.value, 10);
      if (!Number.isNaN(n)) counts.set(qid, n);
    }

    let batchWritten = 0;
    for (const t of batch) {
      const n = counts.get(t.qid);
      if (n === undefined) {
        missing++;
        continue;
      }
      if (!DRY_RUN) {
        try {
          await sql`
            UPDATE wikidata_entities
            SET sitelinks_count = ${n}
            WHERE qid = ${t.qid}
          `;
        } catch (err: any) {
          console.error(`  ✗ ${t.qid}: ${err.message}`);
          continue;
        }
      }
      batchWritten++;
      written++;
    }

    console.log(`${batchWritten}/${batch.length}`);
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }

  console.log(`\n─── done ───`);
  console.log(`  measured : ${written}`);
  console.log(`  no answer: ${missing}`);
  console.log(
    `\nNothing was cut. Measure the distribution of USED vs UNUSED entities before ` +
      `choosing any threshold — and remember the bias: sitelinks measure Wikipedia ` +
      `notability, not historical importance.`,
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
