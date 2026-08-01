// =============================================================================
// flag-polity-tiers.ts
// -----------------------------------------------------------------------------
// Pose le rang STATIQUE subordonné sur wikidata_entities.subordinate (défaut
// false = souverain). DRY-RUN par défaut ; --apply pour écrire. Ne pose JAMAIS
// false (comme le gate `active`) : re-run et tags manuels ne s'écrasent pas.
//
// DOCTRINE DE LA BLACKLIST (validée) — n'auto-flague QUE les TITRES DE RANG
// STATIQUES, qui DISCRIMINENT le rang :
//   • countship, county, lordship, signoria, viscountcy, landgraviate,
//     Marquisate, princely state, Hochstift, free imperial city, electorate…
//     → un comté est TOUJOURS subordonné, quel que soit le moment. Sûr.
// Les classes RELATIONNELLES/TEMPORELLES sont EXCLUES de l'auto-flag (→ AMBIGU) :
//   • vassal/client/satellite/tributary/puppet state, protectorate, colony,
//     « state in the HRE », « crown land of Austria », « state of the German
//     Confederation »… décrivent une RELATION à un instant donné, souvent
//     nominale, et attrapent des QUASI-SOUVERAINS (RDA=satellite, Habsbourg=
//     state-in-HRE, Bohême=crown-land, Ostrogoths=vassal). Les démoter serait
//     faux. Elles ne posent que le DOUTE, pas la démotion : arbitrage manuel.
// Fait décisif : les vrais micro-fiefs portent DÉJÀ un titre statique, donc on
// ne perd rien en jetant le relationnel (County of Sponheim est pris par
// « countship », pas besoin de « state in the HRE »).
//
// OVERRIDE souverain d'abord (sovereign state / empire / kingdom) : bat tout.
//
// CURATION : le writer gère l'ensemble des titres statiques de façon idempotente
// (re-run = ré-affirme, utile quand l'extraction ajoute de nouvelles polities).
// L'arbitrage humain se fait sur les AMBIGUS via /admin/entities (PROMOTION vers
// subordinate=true), que le writer ne touche jamais. Si tu es en désaccord avec
// une CATÉGORIE de titre, corrige la liste ci-dessous — pas les lignes une à une
// (un --apply ultérieur ré-affirmerait le titre).
//
// Usage :
//   DATABASE_URL=... npx -y tsx packages/scripts/src/flag-polity-tiers.ts
//   DATABASE_URL=... npx -y tsx packages/scripts/src/flag-polity-tiers.ts --apply
//   DATABASE_URL=... npx -y tsx packages/scripts/src/flag-polity-tiers.ts --json tiers.json
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";
import { writeFileSync } from "node:fs";

const API = "https://www.wikidata.org/w/api.php";
const BATCH_SIZE = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── OVERRIDE souverain : présent ⇒ souverain, bat tout ────────────────────────
const SOVEREIGN_OVERRIDE: Record<string, string> = {
  Q3624078: "sovereign state",
  Q48349: "empire",
  Q417175: "kingdom",
};

// ── AUTO-FLAG : titres de rang STATIQUES, sûrs (discriminent le rang) ─────────
const SUBORDINATE_CLASSES: Record<string, string> = {
  // Comtés / seigneuries
  Q353344: "countship",
  Q28575: "county",
  Q2991489: "county palatine",
  Q58001476: "condado",
  Q58001343: "comté (France)",
  Q196068: "lordship",
  Q98804020: "marcher lordship",
  Q914425: "signoria",
  Q3556994: "viscountcy",
  Q20856058: "landgraviate",
  Q27492289: "Marquisate",
  // États ecclésiastiques / villes / électorats du Saint-Empire (rang statique)
  Q463742: "Hochstift",
  Q1366274: "Prince-Archbishopric",
  Q57318: "free imperial city",
  Q20521456: "electoral principate",
  Q1507115: "Imperial Estate",
  Q691981: "Duchies of Silesia",
  // Sous-États indiens sous paramountcy
  Q1336152: "princely state",
  Q17319161: "princely estate of the British Raj",
  Q102131920: "thikana",
  Q1678467: "Jagir",
  Q97469558: "Zamindari estate",
  // Autres rangs subordonnés structurels
  Q2494447: "part principality",
  Q1151000: "Tusi",
  Q4765854: "Shan States",
  Q18669740: "South African bantustan",
  Q1625987: "bantustan of South West Africa",
};

// ── AMBIGU : défaut souverain, SIGNALÉ pour arbitrage manuel ──────────────────
// = titres de rang ambigus (un duché peut être souverain ou vassal) + TOUTES les
// classes relationnelles (sorties de l'auto-flag).
const AMBIGUOUS_CLASSES: Record<string, string> = {
  // Rang ambigu
  Q154547: "duchy",
  Q165116: "grand duchy",
  Q208500: "principality",
  Q164950: "dynasty",
  Q1250464: "realm",
  Q836688: "ancient Chinese state",
  Q472538: "sister republic",
  Q107390: "federated state",
  Q18920569: "traditional state in Nigeria",
  // Relationnel / temporel (attrape des quasi-souverains → jamais auto-flaggé)
  Q1371288: "vassal state",
  Q1151405: "client state",
  Q325261: "satellite state",
  Q3241965: "tributary state",
  Q2560551: "vassal/tributary state of the Ottoman Empire",
  Q208164: "puppet state",
  Q164142: "protectorate",
  Q133156: "colony",
  Q1351282: "crown colony",
  Q26879763: "Napoleonic client state",
  Q26830017: "state in the Holy Roman Empire",
  Q681026: "crown land of Austria",
  Q113136497: "state of the German Confederation",
  Q26879769: "state in the Confederation of the Rhine",
  Q17198551: "Vassals of the Kingdom of Jerusalem",
};

type Tier = "SOUVERAIN" | "SUBORDONNÉ";
type Row = {
  qid: string;
  label: string;
  types: string[];
  usage: number;
  tier: Tier;
  viaOverride: boolean;
  reason: string;
  ambiguous: string[];
};

async function fetchJsonRetry(url: string, tries = 4): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await wikiFetchJson(url);
    } catch (err) {
      lastErr = err;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchTypes(qids: string[]): Promise<Map<string, string[]>> {
  const url =
    `${API}?action=wbgetentities&ids=${qids.join("|")}` +
    `&props=claims&format=json&formatversion=2`;
  const data = await fetchJsonRetry(url);
  const out = new Map<string, string[]>();
  for (const [qid, ent] of Object.entries<any>(data?.entities ?? {})) {
    if (ent?.missing !== undefined) continue;
    const p31: string[] = [];
    for (const c of ent?.claims?.P31 ?? []) {
      const id = c?.mainsnak?.datavalue?.value?.id;
      if (id) p31.push(id);
    }
    out.set(qid, p31);
  }
  return out;
}

async function fetchLabels(qids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < qids.length; i += BATCH_SIZE) {
    const batch = qids.slice(i, i + BATCH_SIZE);
    const url =
      `${API}?action=wbgetentities&ids=${batch.join("|")}` +
      `&props=labels&languages=en&format=json&formatversion=2`;
    try {
      const data = await fetchJsonRetry(url);
      for (const [qid, ent] of Object.entries<any>(data?.entities ?? {})) {
        out.set(qid, ent?.labels?.en?.value ?? qid);
      }
    } catch {
      for (const q of batch) if (!out.has(q)) out.set(q, q);
    }
  }
  return out;
}

function classify(
  types: string[],
): Pick<Row, "tier" | "viaOverride" | "reason" | "ambiguous"> {
  const ovr = types.find((t) => SOVEREIGN_OVERRIDE[t]);
  if (ovr) {
    return {
      tier: "SOUVERAIN",
      viaOverride: true,
      reason: `override souverain « ${SOVEREIGN_OVERRIDE[ovr]} » (${ovr})`,
      ambiguous: [],
    };
  }
  const sub = types.find((t) => SUBORDINATE_CLASSES[t]);
  if (sub) {
    return {
      tier: "SUBORDONNÉ",
      viaOverride: false,
      reason: `titre subordonné « ${SUBORDINATE_CLASSES[sub]} » (${sub})`,
      ambiguous: [],
    };
  }
  return {
    tier: "SOUVERAIN",
    viaOverride: false,
    reason: types.length ? "défaut souverain" : "aucun P31",
    ambiguous: types.filter((t) => AMBIGUOUS_CLASSES[t]),
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const jsonIdx = process.argv.indexOf("--json");
  const jsonPath = jsonIdx > -1 ? process.argv[jsonIdx + 1] : null;

  const sql = getSql();
  const entities = await sql<{ qid: string; label: string; usage: number }[]>`
    WITH used AS (
      SELECT e.value->'value'->>'wikidata' AS qid, COUNT(*)::int AS n
      FROM sites s,
           LATERAL jsonb_array_elements(s.timeline->'polity'->'entries') e
      WHERE s.timeline IS NOT NULL
      GROUP BY 1
    )
    SELECT w.qid, w.label_en AS label, COALESCE(u.n, 0) AS usage
    FROM wikidata_entities w
    LEFT JOIN used u ON u.qid = w.qid
    WHERE w.kind = 'polity' AND w.active
    ORDER BY w.label_en
  `;
  console.log(
    `${entities.length} entités kind='polity' (actives)  —  mode ${apply ? "APPLY" : "DRY-RUN"}\n`,
  );

  const rows: Row[] = [];
  const classFreq = new Map<string, number>();
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
      for (const c of t) classFreq.set(c, (classFreq.get(c) ?? 0) + 1);
      rows.push({
        qid: e.qid,
        label: e.label,
        types: t,
        usage: e.usage,
        ...classify(t),
      });
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  const labels = await fetchLabels([...classFreq.keys()]);
  const lbl = (q: string) => labels.get(q) ?? q;

  const sub = rows.filter((r) => r.tier === "SUBORDONNÉ");
  const sov = rows.filter((r) => r.tier === "SOUVERAIN");
  const sovOverride = sov.filter((r) => r.viaOverride);
  const sovDefault = sov.filter((r) => !r.viaOverride);
  const used = (list: Row[]) => list.filter((r) => r.usage > 0).length;

  const subUsed = sub
    .filter((r) => r.usage > 0)
    .sort((a, b) => b.usage - a.usage);
  console.log(
    `SUBORDONNÉS à usage > 0 — le hull les sautera (${subUsed.length})\n${"─".repeat(72)}`,
  );
  for (const r of subUsed) {
    console.log(
      `  ${r.label.slice(0, 42).padEnd(44)} ${r.qid.padEnd(12)} usage:${String(r.usage).padStart(4)}`,
    );
    console.log(`      · ${r.reason}`);
  }

  const ambUsed = sovDefault
    .filter((r) => r.ambiguous.length && r.usage > 0)
    .sort((a, b) => b.usage - a.usage);
  console.log(
    `\nAMBIGUS à usage > 0 — souverains par défaut, à arbitrer via /admin/entities (${ambUsed.length})\n${"─".repeat(72)}`,
  );
  for (const r of ambUsed) {
    console.log(
      `  ${r.label.slice(0, 42).padEnd(44)} ${r.qid.padEnd(12)} usage:${String(r.usage).padStart(4)}`,
    );
    console.log(
      `      · porte : ${r.ambiguous.map((q) => `${lbl(q)} (${q})`).join(", ")}`,
    );
  }

  console.log(`
──────────────────────────────────────────────────────────
  total (actives)            ${rows.length}
  SOUVERAIN                  ${sov.length}   (dont ${used(sov)} utilisées)
    · via override           ${sovOverride.length}
    · par défaut             ${sovDefault.length}
  SUBORDONNÉ (auto-flag)     ${sub.length}   (dont ${used(sub)} utilisées)
──────────────────────────────────────────────────────────`);

  // ── Écriture ──────────────────────────────────────────────────────────────
  const subQids = sub.map((r) => r.qid);
  if (apply) {
    if (!subQids.length) {
      console.log("\nRien à flaguer.");
    } else {
      const updated = await sql<{ qid: string }[]>`
        UPDATE wikidata_entities SET subordinate = true
        WHERE qid IN ${sql(subQids)} AND subordinate = false
        RETURNING qid
      `;
      console.log(
        `\n✓ ${updated.length} entités passées subordinate=true (${subQids.length - updated.length} déjà true, ignorées).`,
      );
      console.log(
        `  Aucune remise à false : les promotions manuelles des AMBIGUS sont préservées.`,
      );
    }
  } else {
    console.log(
      `\nDRY-RUN — rien écrit. ${subQids.length} entités seraient passées subordinate=true.`,
    );
    console.log(
      `Relance avec --apply pour écrire (nécessite la colonne : migration-polity-subordinate.sql).`,
    );
  }

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
