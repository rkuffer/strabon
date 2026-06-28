// packages/scripts/src/ingest-referential.ts
// =============================================================================
// Ingestion du référentiel d'autorité Wikidata dans `wikidata_entities`.
//
// Récupère, par classe-racine SPARQL, les entités politiques et culturelles
// avec leurs labels, alias (EN+FR), description et pays actuel, puis upsert
// idempotent dans la table. Incrémental : INSERT si nouveau QID, UPDATE des
// colonnes d'autorité si existant. Jamais de DELETE.
//
// Lancement : npx tsx packages/scripts/src/ingest-referential.ts
// (nécessite l'accès réseau à query.wikidata.org — validé derrière VPN Arkéa)
// =============================================================================

import { getSql } from "@strabon/db";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// Wikidata EXIGE un User-Agent identifiable, sinon 403.
const USER_AGENT =
  "Strabon2/0.1 (historical atlas; referential ingestion) generic-sparql";

// Classes-racines à ingérer. Le `kind` granulaire est porté par la requête,
// pas déduit a posteriori. (civilization/period viendront plus tard.)
const SOURCES: { kind: string; rootQid: string; label: string }[] = [
  { kind: "polity",  rootQid: "Q3024240", label: "historical country" },
  { kind: "culture", rootQid: "Q465299",  label: "archaeological culture" },
];

// ── Requête SPARQL ────────────────────────────────────────────────────────────
// Une ligne par entité. Label EN obligatoire (entité sans nom anglais = exclue).
// Alias EN+FR et label FR agrégés pour enrichir la recherche. Pas de filtre
// d'exclusion : le test avec/sans a montré qu'il retirait de vraies polities
// (Weimar, Zhou, Ancient Egypt…). Le bruit résiduel est petit et inerte.
function buildQuery(rootQid: string): string {
  return `
    SELECT
      ?e
      (SAMPLE(?enLabel) AS ?label_en)
      (SAMPLE(?frLabel) AS ?label_fr)
      (SAMPLE(?desc)    AS ?description_en)
      (SAMPLE(?country) AS ?country_qid)
      (GROUP_CONCAT(DISTINCT ?alias; SEPARATOR=" | ") AS ?aliases)
    WHERE {
      ?e wdt:P31/wdt:P279* wd:${rootQid} .
      ?e rdfs:label ?enLabel . FILTER(LANG(?enLabel) = "en")
      OPTIONAL { ?e rdfs:label ?frLabel . FILTER(LANG(?frLabel) = "fr") }
      OPTIONAL { ?e schema:description ?desc . FILTER(LANG(?desc) = "en") }
      OPTIONAL { ?e wdt:P17 ?country . }
      OPTIONAL { ?e skos:altLabel ?alias . FILTER(LANG(?alias) IN ("en","fr")) }
    }
    GROUP BY ?e
  `;
}

// ── Appel SPARQL ──────────────────────────────────────────────────────────────

type SparqlRow = Record<string, { value: string } | undefined>;

async function fetchSparql(query: string): Promise<SparqlRow[]> {
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SPARQL HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    results: { bindings: SparqlRow[] };
  };
  return json.results.bindings;
}

// Extrait le QID nu d'une URI Wikidata ("http://.../Q70972" → "Q70972").
function qidFromUri(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

// Construit le search_text : label EN + label FR + alias, dédupliqué.
function buildSearchText(
  labelEn: string,
  labelFr: string | undefined,
  aliases: string | undefined,
): string {
  const parts = new Set<string>();
  parts.add(labelEn);
  if (labelFr) parts.add(labelFr);
  if (aliases) for (const a of aliases.split(" | ")) if (a) parts.add(a);
  return [...parts].join(" ");
}

// ── Upsert ────────────────────────────────────────────────────────────────────

type EntityRow = {
  qid: string;
  kind: string;
  label_en: string;
  description_en: string | null;
  country_qid: string | null;
  search_text: string;
  source_class: string;
};

async function upsertBatch(
  sql: ReturnType<typeof getSql>,
  rows: EntityRow[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  // Chunks pour ne pas dépasser les limites de paramètres.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await sql`
      INSERT INTO wikidata_entities ${sql(
        chunk,
        "qid",
        "kind",
        "label_en",
        "description_en",
        "country_qid",
        "search_text",
        "source_class",
      )}
      ON CONFLICT (qid) DO UPDATE SET
        kind           = EXCLUDED.kind,
        label_en       = EXCLUDED.label_en,
        description_en = EXCLUDED.description_en,
        country_qid    = EXCLUDED.country_qid,
        search_text    = EXCLUDED.search_text,
        source_class   = EXCLUDED.source_class,
        ingested_at    = now()
      RETURNING (xmax = 0) AS inserted
    `;
    for (const r of result) (r as any).inserted ? inserted++ : updated++;
  }
  return { inserted, updated };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function main() {
  const sql = getSql();
  let totalIns = 0;
  let totalUpd = 0;

  for (const src of SOURCES) {
    console.log(`\n[ingest] ${src.label} (${src.rootQid}) → kind=${src.kind}`);
    const t0 = Date.now();
    const bindings = await fetchSparql(buildQuery(src.rootQid));
    console.log(`[ingest]   ${bindings.length} entités reçues en ${Date.now() - t0}ms`);

    const rows: EntityRow[] = bindings.map((b) => {
      const labelEn = b.label_en?.value ?? "";
      const labelFr = b.label_fr?.value;
      const aliases = b.aliases?.value;
      return {
        qid: qidFromUri(b.e!.value),
        kind: src.kind,
        label_en: labelEn,
        description_en: b.description_en?.value ?? null,
        country_qid: b.country_qid ? qidFromUri(b.country_qid.value) : null,
        search_text: buildSearchText(labelEn, labelFr, aliases),
        source_class: src.rootQid,
      };
    });

    // Garde-fou : on n'insère pas une entité sans label EN (ne devrait pas arriver).
    const valid = rows.filter((r) => r.label_en.trim().length > 0);
    if (valid.length !== rows.length) {
      console.warn(`[ingest]   ${rows.length - valid.length} entités sans label EN ignorées`);
    }

    const { inserted, updated } = await upsertBatch(sql, valid);
    console.log(`[ingest]   ✓ ${inserted} insérées, ${updated} mises à jour`);
    totalIns += inserted;
    totalUpd += updated;
  }

  const counts = await sql`
    SELECT kind, COUNT(*) AS n FROM wikidata_entities GROUP BY kind ORDER BY kind
  `;
  console.log(`\n[ingest] === Terminé : ${totalIns} insérées, ${totalUpd} mises à jour ===`);
  for (const c of counts) console.log(`[ingest]   ${c.kind}: ${c.n}`);

  await sql.end();
}

main().catch((err) => {
  console.error("[ingest] ÉCHEC:", err);
  process.exit(1);
});
