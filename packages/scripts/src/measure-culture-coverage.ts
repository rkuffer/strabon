// =============================================================================
// measure-culture-coverage.ts
// -----------------------------------------------------------------------------
// MEASUREMENT ONLY — writes nothing. Answers one question before any doctrine
// change or ingestion is committed:
//
//   "If we used Wikidata's own culture attributions (P2596) instead of hoping
//    extraction rediscovers them, how many sites would each culture gain —
//    and how many of those are already indexed, so gainable at zero cost?"
//
// Why this matters: hulls currently read `timeline`, so a site only joins a
// culture hull once it has been through L2 extraction (expensive, LLM). P2596
// is a deterministic, sourced attribution that exists for sites already sitting
// at L0. The gap between "already in our sites table" and "currently attributed
// in a timeline" is the size of the free win.
//
// Scope classification uses the place_classes TABLE (the atlas's own definition
// of an eligible place), not keyword matching on type labels — a site counts as
// in-scope iff at least one of its P31 types is a class we already accept.
//
// Usage:
//   DATABASE_URL=... npx -y tsx packages/scripts/src/measure-culture-coverage.ts
//   DATABASE_URL=... npx -y tsx packages/scripts/src/measure-culture-coverage.ts --json report.json
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";
import { writeFileSync } from "node:fs";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// Cultures per SPARQL query. Kept small on purpose: a single prolific culture
// (Ancient Rome ~2300 sites) can dominate a batch, and WDQS times out at 60s.
const BATCH_SIZE = 12;

type Row = {
  qid: string;
  label: string;
  wdTotal: number; // geolocated sites attributed by Wikidata
  inScope: number; // ... whose P31 is an accepted place class
  outOfScope: number; // ... whose P31 is not (funerary, monuments…)
  unknownType: number; // ... with no P31 at all
  alreadyIndexed: number; // in-scope AND already present in our sites table
  alreadyExtracted: number; // ... and already carrying a timeline
  currentlyAttributed: number; // sites whose timeline culture track cites this QID today
};

function qidFromUri(uri: string): string {
  return uri.replace(/^.*\/entity\//, "");
}

async function sparqlSites(
  cultureQids: string[],
): Promise<Map<string, { site: string; types: string[] }[]>> {
  const values = cultureQids.map((q) => `wd:${q}`).join(" ");
  const query = `
    SELECT ?c ?site ?type WHERE {
      VALUES ?c { ${values} }
      ?site wdt:P2596 ?c ;
            wdt:P625 ?coord .
      OPTIONAL { ?site wdt:P31 ?type }
    }`;

  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const data = await wikiFetchJson(url);

  // A site with several P31 values yields several rows — regroup by site.
  const perCulture = new Map<string, Map<string, Set<string>>>();
  for (const b of data?.results?.bindings ?? []) {
    const c = qidFromUri(b.c.value);
    const site = qidFromUri(b.site.value);
    const type = b.type ? qidFromUri(b.type.value) : null;
    if (!perCulture.has(c)) perCulture.set(c, new Map());
    const sites = perCulture.get(c)!;
    if (!sites.has(site)) sites.set(site, new Set());
    if (type) sites.get(site)!.add(type);
  }

  const out = new Map<string, { site: string; types: string[] }[]>();
  for (const [c, sites] of perCulture) {
    out.set(
      c,
      [...sites].map(([site, types]) => ({ site, types: [...types] })),
    );
  }
  return out;
}

async function main() {
  const jsonFlagIdx = process.argv.indexOf("--json");
  const jsonPath = jsonFlagIdx > -1 ? process.argv[jsonFlagIdx + 1] : null;

  const sql = getSql();

  // 1. The culture referential — the entities whose hulls we care about.
  const cultures = await sql<{ qid: string; label: string }[]>`
    SELECT qid, label_en AS label
    FROM wikidata_entities
    WHERE kind = 'culture'
    ORDER BY label_en
  `;
  console.log(`Référentiel culture : ${cultures.length} entités\n`);

  // 2. Accepted place classes — the atlas's own scope definition.
  const classes = await sql<{ qid: string }[]>`SELECT qid FROM place_classes`;
  const acceptedClasses = new Set(classes.map((c) => c.qid));
  console.log(`place_classes : ${acceptedClasses.size} classes acceptées\n`);

  // 3. What each culture is attributed TODAY in our extracted timelines.
  const attributed = await sql<{ qid: string; n: number }[]>`
    SELECT e.value->'value'->>'wikidata' AS qid, COUNT(*)::int AS n
    FROM sites s,
         LATERAL jsonb_array_elements(s.timeline->'culture'->'entries') e
    WHERE s.timeline IS NOT NULL
      AND e.value->'value'->>'wikidata' IS NOT NULL
    GROUP BY 1
  `;
  const attributedNow = new Map(attributed.map((r) => [r.qid, r.n]));

  const rows: Row[] = [];

  for (let i = 0; i < cultures.length; i += BATCH_SIZE) {
    const batch = cultures.slice(i, i + BATCH_SIZE);
    process.stderr.write(
      `\r  interrogation Wikidata ${i + batch.length}/${cultures.length}…`,
    );

    let perCulture: Map<string, { site: string; types: string[] }[]>;
    try {
      perCulture = await sparqlSites(batch.map((c) => c.qid));
    } catch (err: any) {
      // A batch that times out must not lose the whole run — report and move on.
      console.error(
        `\n  ⚠ lot ${batch.map((b) => b.qid).join(",")} échoué : ${err?.message}`,
      );
      continue;
    }

    for (const culture of batch) {
      const sites = perCulture.get(culture.qid) ?? [];
      if (!sites.length) continue;

      const inScopeQids: string[] = [];
      let outOfScope = 0;
      let unknownType = 0;

      for (const s of sites) {
        if (!s.types.length) {
          unknownType++;
        } else if (s.types.some((t) => acceptedClasses.has(t))) {
          inScopeQids.push(s.site);
        } else {
          outOfScope++;
        }
      }

      // 4. Which of those in-scope sites do we ALREADY hold?
      let alreadyIndexed = 0;
      let alreadyExtracted = 0;
      if (inScopeQids.length) {
        const known = await sql<{ wikidata_id: string; extracted: boolean }[]>`
          SELECT wikidata_id, (timeline IS NOT NULL) AS extracted
          FROM sites
          WHERE wikidata_id = ANY(${inScopeQids})
        `;
        alreadyIndexed = known.length;
        alreadyExtracted = known.filter((k) => k.extracted).length;
      }

      rows.push({
        qid: culture.qid,
        label: culture.label,
        wdTotal: sites.length,
        inScope: inScopeQids.length,
        outOfScope,
        unknownType,
        alreadyIndexed,
        alreadyExtracted,
        currentlyAttributed: attributedNow.get(culture.qid) ?? 0,
      });
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  rows.sort((a, b) => b.inScope - a.inScope);

  // ── Rapport ───────────────────────────────────────────────────────────────
  const H = [
    "culture".padEnd(32),
    "WD".padStart(6),
    "scope".padStart(7),
    "hors".padStart(6),
    "connus".padStart(7),
    "extr.".padStart(6),
    "actuel".padStart(7),
    "gain".padStart(6),
  ].join("");
  console.log(H);
  console.log("-".repeat(H.length));

  let tot = { wd: 0, scope: 0, out: 0, known: 0, extracted: 0, now: 0 };
  for (const r of rows.slice(0, 40)) {
    // "gain" = sites in scope already indexed but NOT yet attributed to this
    // culture — the free win, no tiling and no extraction needed.
    const gain = Math.max(0, r.alreadyIndexed - r.currentlyAttributed);
    console.log(
      [
        r.label.slice(0, 31).padEnd(32),
        String(r.wdTotal).padStart(6),
        String(r.inScope).padStart(7),
        String(r.outOfScope).padStart(6),
        String(r.alreadyIndexed).padStart(7),
        String(r.alreadyExtracted).padStart(6),
        String(r.currentlyAttributed).padStart(7),
        String(gain).padStart(6),
      ].join(""),
    );
  }
  for (const r of rows) {
    tot.wd += r.wdTotal;
    tot.scope += r.inScope;
    tot.out += r.outOfScope;
    tot.known += r.alreadyIndexed;
    tot.extracted += r.alreadyExtracted;
    tot.now += r.currentlyAttributed;
  }
  console.log("-".repeat(H.length));
  console.log(
    [
      `TOTAL (${rows.length} cultures)`.padEnd(32),
      String(tot.wd).padStart(6),
      String(tot.scope).padStart(7),
      String(tot.out).padStart(6),
      String(tot.known).padStart(7),
      String(tot.extracted).padStart(6),
      String(tot.now).padStart(7),
      String(Math.max(0, tot.known - tot.now)).padStart(6),
    ].join(""),
  );

  console.log(`
Lecture des colonnes :
  WD      sites géolocalisés que Wikidata attribue à cette culture (P2596)
  scope   ... dont le type P31 est une classe acceptée par place_classes
  hors    ... dont le type est HORS périmètre actuel (funéraire, monuments) —
          c'est ce que ferait gagner un changement de doctrine
  connus  parmi « scope », ceux DÉJÀ présents dans notre table sites
  extr.   ... et déjà extraits (L2)
  actuel  sites attribués à cette culture dans nos timelines AUJOURD'HUI
  gain    « connus » − « actuel » = gain immédiat, sans tuilage ni extraction
`);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
    console.log(`Rapport détaillé écrit dans ${jsonPath}`);
  }

  await closeSql();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
