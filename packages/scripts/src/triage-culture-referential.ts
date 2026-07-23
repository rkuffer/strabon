// =============================================================================
// triage-culture-referential.ts
// -----------------------------------------------------------------------------
// TRIAGE ONLY — writes nothing. Produces a decision list for the culture
// referential, plus the SQL to apply whatever Rodolphe arbitrates.
//
// Why this matters beyond the hulls
// ---------------------------------
// wikidata_entities is injected into the extraction prompt as the list of
// AUTHORISED QIDs. An intruder there is not inert: it hands the model a
// plausible-looking wrong answer for the culture track. The LLM bounds pass
// surfaced ~25 of them among 657 entities — the abstract concept "culture"
// (Q634818), individual listed monuments ("Cultural heritage D-1-7941-0217 in
// Altenmarkt"), UNESCO designations, ~12 "Prehistory of <country>" survey
// articles, a Roman welfare institution (alimentum), a historiographical theme
// ("Women in prehistory"), a site (Monte Circeo).
//
// Why the verdict is NOT automatic
// --------------------------------
// Measured on Wikidata: the abstract concept "culture", "Yoruba architecture"
// and "Monte Circeo" are ALL typed P31 = "archaeological culture". So the class
// cannot be a KEEP criterion — Wikidata mis-types its own items. What DOES
// discriminate is the presence of a disqualifying class (prehistory, aspect of
// history, tumulus, architectural ensemble, region…). Everything else is
// reported as a SIGNAL, and the arbitration stays human — consistent with the
// project's rule against fuzzy heuristics that silently drop data.
//
// SETTLED DOCTRINE (Rodolphe, do not re-litigate): the `culture` track is a
// deliberate catch-all — it holds archaeological cultures, PERIODS (Akkad
// period), CIVILIZATIONS (Ancient Egypt, Ancestral Puebloans) and ethnonyms
// alike. Splitting those would be a lot of overhead for little gain. So
// "historical period" and "civilization" disqualify NOTHING, and the atlas has
// NO lower date limit — an Acheulean industry at -1,760,000 is in scope, not an
// anomaly. Only entities that are not cultural-chronological labels AT ALL are
// exclusion candidates.
//
// The ethnonym is still reported, as an INFORMATIONAL signal only: the model
// writes Gauls 36× against Hallstatt 6×, where Wikidata's own P2596 cataloguing
// is 11 vs 207 — the ratio is inverted. But that is a GRANULARITY problem, not
// a legitimacy one; it belongs to a prompt preference rule ("between an
// ethnonym and an archaeological culture, name the archaeological culture"),
// never to removing the entity from the referential.
//
// Usage:
//   DATABASE_URL=... npx -y tsx packages/scripts/src/triage-culture-referential.ts
//   DATABASE_URL=... npx -y tsx packages/scripts/src/triage-culture-referential.ts --json triage.json
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";
import { writeFileSync } from "node:fs";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const BATCH_SIZE = 60;

// DOCTRINE : l'atlas n'a AUCUNE borne basse — il couvre le Paléolithique
// (règle de prompt 2). Aucun contrôle d'ancienneté ici : une industrie
// acheuléenne datée de -1 760 000 est dans le périmètre, pas une anomalie.

// Classes qui DISQUALIFIENT : leur présence dit que l'entité n'est pas une
// culture, quel que soit ce que dit par ailleurs son P31.
const DISQUALIFYING: Record<string, string> = {
  prehistory: "article de synthèse (préhistoire d'un pays)",
  "aspect of history": "article de synthèse",
  tumulus: "monument individuel",
  "architectural ensemble": "ensemble bâti / classement",
  "World Heritage Site": "classement UNESCO",
  region: "région géographique",
  "cultural heritage": "classement patrimonial",
  "Wikimedia list article": "page Wikimedia",
  "Wikimedia disambiguation page": "page Wikimedia",
};

// Classes disqualifiantes SEULEMENT en l'absence de toute classe de culture.
//
// « archaeological site » ne peut pas être fatal en soi : les cultures ÉPONYMES
// portent le nom de leur site type, et Wikidata leur attribue légitimement les
// deux classes (Dadiwan, Badari, et le motif vaut pour Hallstatt, La Tène,
// Villanova…). Une entité typée à la fois culture ET site est le cas NORMAL,
// pas un intrus. En revanche, un site typé UNIQUEMENT site n'a rien à faire
// dans un référentiel de cultures.
const DISQUALIFYING_IF_NOT_CULTURE: Record<string, string> = {
  "archaeological site": "site seul, sans classe de culture",
};

// Classes indiquant qu'on a bien affaire à un label chrono-culturel (test
// SOUPLE, par inclusion). Sert seulement à repérer les entités dont AUCUN type
// n'évoque une culture — pas à valider celles qui en portent un.
const CULTURE_CLASSES = [
  "culture",
  "civilization",
  "period",
  "style",
  "tradition",
  "industry",
];

// SIGNAL INFORMATIF, JAMAIS une proposition d'exclusion.
//
// DOCTRINE actée : la piste `culture` est un fourre-tout assumé — elle accueille
// cultures archéologiques, PÉRIODES (période d'Akkad) et CIVILISATIONS (Égypte
// antique, Ancestral Puebloans). Ni "historical period" ni "civilization" ne
// disqualifient donc quoi que ce soit ; les traiter autrement produisait une
// incohérence pure (Ancestral Puebloans écarté pour cause de « civilization »,
// Égypte antique gardée — au seul hasard du typage Wikidata).
//
// L'ethnonyme reste signalé parce qu'un problème MESURÉ y est attaché : le
// modèle écrit Gauls 36 fois contre Hallstatt 6, quand le catalogage P2596 de
// Wikidata fait l'inverse (11 contre 207). Mais c'est un problème de
// GRANULARITÉ, pas de légitimité — il se traite par une règle de préférence
// dans le prompt (« entre un ethnonyme et une culture archéologique, nommer la
// culture archéologique »), jamais en retirant l'entité du référentiel.
const SIGNALS: Record<string, string> = {
  "historical ethnic group":
    "ethnonyme — signal de granularité, PAS une exclusion",
  "ethnic group": "ethnonyme — signal de granularité, PAS une exclusion",
};

type Row = {
  qid: string;
  label: string;
  types: string[];
  inception: number | null;
  dissolution: number | null;
  bounds_source: string | null;
  usage: number;
  verdict: "EXCLURE" | "SIGNAL" | "VÉRIFIER" | "GARDER";
  reasons: string[];
};

function qidFromUri(u: string): string {
  return u.replace(/^.*\/entity\//, "");
}

async function fetchTypes(qids: string[]): Promise<Map<string, string[]>> {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  const query = `
    SELECT ?e ?typeLabel WHERE {
      VALUES ?e { ${values} }
      ?e wdt:P31 ?type .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const data = await wikiFetchJson(url);

  const out = new Map<string, string[]>();
  for (const b of data?.results?.bindings ?? []) {
    const q = qidFromUri(b.e.value);
    if (!out.has(q)) out.set(q, []);
    out.get(q)!.push(b.typeLabel.value);
  }
  return out;
}

async function main() {
  const jsonIdx = process.argv.indexOf("--json");
  const jsonPath = jsonIdx > -1 ? process.argv[jsonIdx + 1] : null;

  const sql = getSql();

  // Usage réel : une entité utilisée nulle part est sans risque à écarter ;
  // une entité très utilisée mérite un regard avant toute exclusion.
  const entities = await sql<
    {
      qid: string;
      label: string;
      inception: number | null;
      dissolution: number | null;
      bounds_source: string | null;
      usage: number;
    }[]
  >`
    WITH used AS (
      SELECT e.value->'value'->>'wikidata' AS qid, COUNT(*)::int AS n
      FROM sites s,
           LATERAL jsonb_array_elements(s.timeline->'culture'->'entries') e
      WHERE s.timeline IS NOT NULL
      GROUP BY 1
    )
    SELECT w.qid, w.label_en AS label, w.inception, w.dissolution,
           w.bounds_source, COALESCE(u.n, 0) AS usage
    FROM wikidata_entities w
    LEFT JOIN used u ON u.qid = w.qid
    WHERE w.kind = 'culture'
    ORDER BY w.label_en
  `;
  console.log(`${entities.length} entités kind='culture'\n`);

  const rows: Row[] = [];

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);
    process.stderr.write(
      `\r  Wikidata ${Math.min(i + BATCH_SIZE, entities.length)}/${entities.length}…`,
    );

    let types: Map<string, string[]>;
    try {
      types = await fetchTypes(batch.map((e) => e.qid));
    } catch (err: any) {
      console.error(`\n  ⚠ lot ${i} échoué : ${err?.message}`);
      types = new Map();
    }

    for (const e of batch) {
      const t = types.get(e.qid) ?? [];
      const reasons: string[] = [];

      const isCulture = t.some((x) =>
        CULTURE_CLASSES.some((c) => x.toLowerCase().includes(c)),
      );

      for (const [cls, why] of Object.entries(DISQUALIFYING)) {
        if (t.some((x) => x.toLowerCase() === cls.toLowerCase())) {
          reasons.push(`P31 « ${cls} » → ${why}`);
        }
      }
      if (!isCulture) {
        for (const [cls, why] of Object.entries(DISQUALIFYING_IF_NOT_CULTURE)) {
          if (t.some((x) => x.toLowerCase() === cls.toLowerCase())) {
            reasons.push(`P31 « ${cls} » → ${why}`);
          }
        }
      }
      const signals: string[] = [];
      for (const [cls, why] of Object.entries(SIGNALS)) {
        if (t.some((x) => x.toLowerCase() === cls.toLowerCase())) {
          signals.push(`P31 « ${cls} » → ${why}`);
        }
      }

      // ── Seconds axes, nécessaires car le P31 seul ne suffit pas ──────────
      // Mesuré : « culture » (le concept abstrait), « Yoruba architecture » et
      // « Monte Circeo » (un site) sont TOUS typés P31 = archaeological culture
      // par Wikidata. Aucune classe ne les distingue d'une vraie culture.
      const soft: string[] = [];

      // (a) Aucune classe plausible de culture. Attrape « alimentum », dont le
      //     seul P31 est « Ancient Rome ».
      if (t.length && !isCulture) {
        soft.push(`aucune classe de culture (P31: ${t.join(", ")})`);
      }

      // (b) Non datable même par la passe LLM. Une culture archéologique
      //     réelle a des bornes, fût-ce au siècle près ; un concept abstrait,
      //     un thème historiographique ou un article de synthèse n'en ont pas.
      //     Signal fiable UNIQUEMENT si la passe LLM a déjà tourné (sinon tout
      //     le référentiel remonterait).
      if (e.bounds_source == null) {
        soft.push("non datable, y compris par la passe LLM");
      }

      const noType = t.length === 0;
      if (noType) soft.push("aucun P31 sur Wikidata");

      let verdict: Row["verdict"];
      if (reasons.length) verdict = "EXCLURE";
      else if (signals.length) verdict = "SIGNAL";
      else if (soft.length) verdict = "VÉRIFIER";
      else verdict = "GARDER";

      rows.push({
        qid: e.qid,
        label: e.label,
        types: t,
        inception: e.inception,
        dissolution: e.dissolution,
        bounds_source: e.bounds_source,
        usage: e.usage,
        verdict,
        reasons: [...reasons, ...signals, ...soft],
      });
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  const by = (v: Row["verdict"]) => rows.filter((r) => r.verdict === v);
  const show = (title: string, list: Row[]) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length})\n${"─".repeat(70)}`);
    for (const r of list.sort((a, b) => b.usage - a.usage)) {
      console.log(
        `  ${r.label.slice(0, 40).padEnd(42)} ${r.qid.padEnd(12)} usage:${String(r.usage).padStart(4)}`,
      );
      for (const why of r.reasons) console.log(`      · ${why}`);
    }
  };

  show("À EXCLURE — ce ne sont pas des cultures", by("EXCLURE"));
  show("SIGNAL — ethnonymes (granularité, PAS une exclusion)", by("SIGNAL"));
  show("À VÉRIFIER — sans classe Wikidata", by("VÉRIFIER"));

  const excl = by("EXCLURE");
  const used = excl.filter((r) => r.usage > 0);

  console.log(`
──────────────────────────────────────────────────────────
  total                      ${rows.length}
  à exclure                  ${excl.length}   (dont ${used.length} déjà utilisées par des sites)
  signal (ethnonymes)        ${by("SIGNAL").length}
  à vérifier                 ${by("VÉRIFIER").length}
  à garder                   ${by("GARDER").length}
──────────────────────────────────────────────────────────`);

  if (used.length) {
    console.log(`
⚠ ${used.length} entités à exclure sont DÉJÀ RÉFÉRENCÉES par des timelines
  extraites. Les retirer du référentiel n'efface pas ces entrées (elles
  survivent par leur nom), mais leur QID ne sera plus résolvable : elles
  basculeront en gaps. À arbitrer avant d'appliquer.`);
  }

  // SQL proposé, JAMAIS exécuté ici — l'arbitrage reste humain.
  console.log(`
SQL proposé (à relire, puis exécuter si tu valides) :

-- Exclusion réversible plutôt que DELETE : la curation est une donnée, on ne
-- la détruit pas. Ajoute la colonne si elle n'existe pas encore.
ALTER TABLE wikidata_entities
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

UPDATE wikidata_entities SET active = false WHERE qid IN (
${excl.map((r) => `  '${r.qid}'`).join(",\n") || "  -- rien à exclure"}
);

-- Puis filtrer sur active = true là où le référentiel est injecté dans le
-- prompt d'extraction, et dans lookup_entity.`);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
    console.log(`\nRapport détaillé : ${jsonPath}`);
  }

  await closeSql();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
