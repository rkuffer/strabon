/**
 * Fills the chronological bounds of `wikidata_entities` from Wikidata.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `step` track (polity, culture) has no termination mechanism: its last entry
 * runs to the end of occupation. The model, correctly told to stop when
 * documented history begins, falls silent — and our renderer turns that silence
 * into an assertion. Hence "Merovingian culture, 1990" over France, and
 * "Kingdom of Italy, 1990" over Milan.
 *
 * Entity bounds are the only DETERMINISTIC guard against this. They do not
 * depend on the model's obedience — which we have measured, repeatedly, to be
 * unreliable in exactly the way that matters: it diagnoses correctly, writes the
 * diagnosis in its notes, and then acts against it.
 *
 * WHAT A BOUND IS, AND IS NOT
 * ---------------------------
 * A bound is a CEILING, never a truth. A culture may die locally long before the
 * entity "ends" globally. So we take the WIDEST bounds Wikidata offers: the
 * earliest inception, the latest dissolution. We would rather cut too little
 * than erase a true fact.
 *
 * Bounds mostly matter for MORTAL entities — polities and cultures. Catholicism
 * has no dissolution date, and neither does French; a NULL there means "this
 * entity has not died", which is correct, not missing. Co-occurrent tracks close
 * themselves through their `to` field.
 *
 * PRECISION IS CARRIED, NOT DISCARDED
 * -----------------------------------
 * Wikidata timePrecision: 6 = millennium, 7 = century, 8 = decade, 9 = year.
 * It maps directly onto our `from_precision`. Without it, shortening an entry to
 * an entity's inception would turn "circa 4500 BC" into a hard fact — the very
 * vice we hunt everywhere else.
 *
 * Usage:
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/entity-bounds-sparql.ts
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/entity-bounds-sparql.ts --dry-run
 *   DATABASE_URL=... npx -y tsx packages/scripts/src/entity-bounds-sparql.ts --kind polity
 */

import postgres from "postgres";

const WDQS = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "Strabon/1.0 (historical atlas; contact via github.com/rkuffer/strabon)";

// Wikidata rejects oversized VALUES clauses and rate-limits aggressive clients.
const BATCH_SIZE = 150;
const SPACING_MS = 1200;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KIND_FILTER = args.includes("--kind")
  ? args[args.indexOf("--kind") + 1]
  : null;

type Bounds = {
  inception: number | null;
  inceptionPrecision: number | null;
  dissolution: number | null;
  dissolutionPrecision: number | null;
};

/**
 * Wikidata time values: "-0249-01-01T00:00:00Z" or "1991-12-26T00:00:00Z".
 * The leading "+" is NOT always emitted — the sign must be optional, or every
 * AD date is silently dropped.
 *
 * Wikidata also allows geological and cosmological precisions (billions of
 * years). One entity in the referential carries an inception of -84,000,000,000
 * — six times the age of the universe. Such values are not bounds we failed to
 * store, they are bounds that mean nothing for an atlas of inhabited places
 * spanning 12,000 years. We reject them rather than widen the column: a value
 * outside the human range is a typing error in Wikidata, not a fact.
 */
const MIN_YEAR = -200_000; // well before any inhabited site
const MAX_YEAR = 2_100;

function parseWikidataYear(value: string): number | null {
  const m = /^([+-]?)(\d+)-/.exec(value);
  if (!m) return null;
  const year = parseInt(m[2], 10);
  if (Number.isNaN(year)) return null;
  const signed = m[1] === "-" ? -year : year;
  if (signed < MIN_YEAR || signed > MAX_YEAR) return null;
  // Wikidata's RDF export uses ASTRONOMICAL years (XSD 1.1: 1 BCE is year 0).
  // Our timelines use HISTORICAL years (no year 0). 753 BC is -0752 in Wikidata
  // and -753 for us. Without this, every BC bound is off by one — silently, and
  // in the exact direction that produces spurious "shorten" actions on antiquity.
  // Ref: https://www.wikidata.org/wiki/Help:Dates
  return signed <= 0 ? signed - 1 : signed;
}

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
    if (!res.ok) {
      throw new Error(`SPARQL ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as any;
    return json.results.bindings;
  }
  throw new Error("SPARQL: exhausted retries");
}

/**
 * P571 (inception) / P576 (dissolved) are the canonical pair. P580 (start time)
 * / P582 (end time) are the fallback: many former countries model existence as
 * a period rather than as a founding.
 *
 * CRITICAL: go through p:/psv: ONLY, never wdt:. The truthy `wdt:` predicate
 * exposes only the PREFERRED value of a statement — so an entity with several
 * competing or disputed claims (the USSR has two inception dates, one flagged
 * "statement disputed by") exposes nothing at all through wdt:, and joining on
 * it silently drops the entity. Which is why the first version of this query
 * missed the Soviet Union, Northumbria and Denmark-Norway: the bug bit hardest
 * on the entities that matter most, because those are the ones with enough
 * editors to have contested statements.
 *
 * We take every value and reduce in TS: earliest inception, latest dissolution.
 * A bound is a ceiling, never a truth — we would rather cut too little.
 */
function buildQuery(qids: string[]): string {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  return `
SELECT ?e ?kind ?time ?precision WHERE {
  VALUES ?e { ${values} }
  {
    ?e p:P571 ?st . ?st psv:P571 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("inception" AS ?kind)
  } UNION {
    ?e p:P580 ?st . ?st psv:P580 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("inception" AS ?kind)
  } UNION {
    ?e p:P576 ?st . ?st psv:P576 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("dissolution" AS ?kind)
  } UNION {
    ?e p:P582 ?st . ?st psv:P582 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("dissolution" AS ?kind)
  }
}`;
}

async function fetchBounds(qids: string[]): Promise<Map<string, Bounds>> {
  const rows = await sparqlQuery(buildQuery(qids));
  const out = new Map<string, Bounds>();

  for (const r of rows) {
    const qid = r.e.value.replace("http://www.wikidata.org/entity/", "");
    const year = parseWikidataYear(r.time.value);
    if (year === null) continue;
    const precision = parseInt(r.precision.value, 10);

    const cur =
      out.get(qid) ??
      ({
        inception: null,
        inceptionPrecision: null,
        dissolution: null,
        dissolutionPrecision: null,
      } as Bounds);

    if (r.kind.value === "inception") {
      // Widest window: keep the EARLIEST inception.
      if (cur.inception === null || year < cur.inception) {
        cur.inception = year;
        cur.inceptionPrecision = precision;
      }
    } else {
      // Widest window: keep the LATEST dissolution.
      if (cur.dissolution === null || year > cur.dissolution) {
        cur.dissolution = year;
        cur.dissolutionPrecision = precision;
      }
    }

    out.set(qid, cur);
  }

  return out;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  const targets = await sql<{ qid: string; kind: string; label_en: string }[]>`
    SELECT qid, kind, label_en
    FROM wikidata_entities
    WHERE bounds_source IS NULL
      AND active
      ${KIND_FILTER ? sql`AND kind = ${KIND_FILTER}` : sql``}
    ORDER BY kind, qid
  `;

  console.log(
    `${targets.length} entities without bounds${KIND_FILTER ? ` (kind=${KIND_FILTER})` : ""}`,
  );
  if (DRY_RUN) console.log("DRY RUN — nothing will be written\n");

  const stats = {
    both: 0,
    inceptionOnly: 0,
    dissolutionOnly: 0,
    none: 0,
  };

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const qids = batch.map((t) => t.qid);

    process.stdout.write(
      `[${i + 1}-${Math.min(i + BATCH_SIZE, targets.length)}/${targets.length}] `,
    );

    let bounds: Map<string, Bounds>;
    try {
      bounds = await fetchBounds(qids);
    } catch (err: any) {
      console.error(`✗ batch failed: ${err.message}`);
      continue;
    }

    let written = 0;

    for (const t of batch) {
      const b = bounds.get(t.qid);

      if (!b || (b.inception === null && b.dissolution === null)) {
        stats.none++;
        continue;
      }
      if (b.inception !== null && b.dissolution !== null) stats.both++;
      else if (b.inception !== null) stats.inceptionOnly++;
      else stats.dissolutionOnly++;

      if (!DRY_RUN) {
        try {
          await sql`
            UPDATE wikidata_entities SET
              inception             = ${b.inception},
              inception_precision   = ${b.inceptionPrecision},
              dissolution           = ${b.dissolution},
              dissolution_precision = ${b.dissolutionPrecision},
              bounds_source         = 'sparql',
              bounds_confirmed      = TRUE,
              bounds_updated_at     = now()
            WHERE qid = ${t.qid}
          `;
        } catch (err: any) {
          console.error(`  ✗ ${t.qid} (${t.label_en}): ${err.message}`);
          continue;
        }
      }
      written++;
    }

    console.log(`${written}/${batch.length} bounded`);
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }

  console.log("\n─── SPARQL pass done ───");
  console.log(`  both bounds      : ${stats.both}`);
  console.log(`  inception only   : ${stats.inceptionOnly}`);
  console.log(`  dissolution only : ${stats.dissolutionOnly}`);
  console.log(`  nothing found    : ${stats.none}`);
  console.log(
    "\nNote: a missing dissolution on a religion or a language is CORRECT — " +
      "those entities have not died. Only polities and cultures are expected " +
      "to be broadly bounded.",
  );

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
