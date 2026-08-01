// =============================================================================
// measure-polity-tiers.ts  (v2 — modèle INVERSÉ)
// -----------------------------------------------------------------------------
// MESURE SEULE — n'écrit rien. Décide si le chantier « déclutter micro-polities »
// est léger ou lourd AVANT de toucher hulls.ts (règle « mesurer avant de bâtir »).
//
// Ce que la v1 a montré (et qui a retourné le design)
// ---------------------------------------------------
// 91 % des polities ne portent que `historical country` (Q3024240) — une classe
// BRUIT qui recouvre INDISTINCTEMENT souverains et subordonnés : Roman Empire,
// Byzance, Kingdom of France (souverains majeurs, très utilisés) ET Duchy of
// Milan, Duchy of Savoy (subordonnés) n'ont QUE ça. Détecter le SOUVERAIN par
// classe est donc non fiable — les gros empires se cachent. Détecter le
// SUBORDONNÉ par classe l'est : un subordonné porte presque toujours un titre
// spécifique (countship, lordship, princely state, Hochstift, vassal state…).
//
// D'où le modèle INVERSÉ : BLACKLIST des subordonnés, DÉFAUT = souverain. Le
// hull saute uniquement les entités explicitement taguées subordonnées ; tout
// le reste (dont la masse « historical country ») porte le hull, gratuitement
// et correctement.
//
// OVERRIDE souverain — nécessaire même ici : la Prusse porte sovereign state ET
// state of the German Confederation. Sans override, un marqueur subordonné la
// démoterait à tort. Donc : un marqueur souverain FORT (sovereign state, empire,
// kingdom) bat tout marqueur subordonné.
//
// Fetch : wbgetentities (API, claims complets, fiable) au lieu du SPARQL WDQS
// qui renvoyait des 503 et des P31 PARTIELS (le SHR et la Prusse n'y remontaient
// que « historical country »), ce qui sous-estimait le compte souverain.
//
// Les listes ci-dessous sont un point de départ ; le TABLEAU DE FRÉQUENCE + la
// pile AMBIGU (usage > 0) disent quoi ajuster. Ce script n'écrit RIEN : le choix
// du support (colonne `tier` / booléen `subordinate` sur wikidata_entities) est
// une décision d'architecture à prendre APRÈS lecture des chiffres.
//
// Usage :
//   DATABASE_URL=... npx -y tsx packages/scripts/src/measure-polity-tiers.ts
//   DATABASE_URL=... npx -y tsx packages/scripts/src/measure-polity-tiers.ts --json tiers.json
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";
import { writeFileSync } from "node:fs";

const API = "https://www.wikidata.org/w/api.php";
const BATCH_SIZE = 50; // limite wbgetentities

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── OVERRIDE souverain : présent ⇒ souverain, quel que soit le reste ──────────
const SOVEREIGN_OVERRIDE: Record<string, string> = {
  Q3624078: "sovereign state",
  Q48349: "empire",
  Q417175: "kingdom",
};

// ── BLACKLIST subordonnés : marqueurs FIABLES de « composant, pas souverain » ──
// (QID relevés dans la sortie réelle de la v1, donc vérifiés existants.)
const SUBORDINATE_CLASSES: Record<string, string> = {
  // Tissu féodal européen
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
  // Saint-Empire / confédérations germaniques
  Q26830017: "state in the Holy Roman Empire",
  Q463742: "Hochstift",
  Q1366274: "Prince-Archbishopric",
  Q57318: "free imperial city",
  Q20521456: "electoral principate",
  Q1507115: "Imperial Estate",
  Q26879769: "state in the Confederation of the Rhine",
  Q26879763: "Napoleonic client state",
  Q113136497: "state of the German Confederation",
  Q691981: "Duchies of Silesia",
  Q681026: "crown land of Austria",
  // Vassalité explicite
  Q1371288: "vassal state",
  Q1151405: "client state",
  Q3241965: "tributary state",
  Q2560551: "vassal/tributary state of the Ottoman Empire",
  Q17198551: "Vassals of the Kingdom of Jerusalem",
  Q2494447: "part principality",
  Q325261: "satellite state",
  // Sous-États indiens sous paramountcy
  Q1336152: "princely state",
  Q17319161: "princely estate of the British Raj",
  Q102131920: "thikana",
  Q1678467: "Jagir",
  Q97469558: "Zamindari estate",
  // Autres subordinations structurelles
  Q1151000: "Tusi",
  Q4765854: "Shan States",
  Q18669740: "South African bantustan",
  Q1625987: "bantustan of South West Africa",
};

// ── AMBIGU : par défaut SOUVERAIN, mais signalé pour arbitrage humain ─────────
// Un duché peut être souverain (Milan) ou vassal (Bavière dans l'Empire) ; la
// classe ne tranche pas. Ces entités PORTENT le hull par défaut ; à toi de
// décider si certaines doivent basculer subordonnées.
const AMBIGUOUS_CLASSES: Record<string, string> = {
  Q154547: "duchy",
  Q165116: "grand duchy",
  Q208500: "principality",
  Q164950: "dynasty",
  Q1250464: "realm",
  Q836688: "ancient Chinese state",
  Q208164: "puppet state",
  Q164142: "protectorate",
  Q133156: "colony",
  Q1351282: "crown colony",
  Q107390: "federated state",
  Q472538: "sister republic",
  Q18920569: "traditional state in Nigeria",
};

type Tier = "SOUVERAIN" | "SUBORDONNÉ";
type Row = {
  qid: string;
  label: string;
  types: string[]; // QID des classes P31
  usage: number;
  tier: Tier;
  viaOverride: boolean;
  reason: string;
  ambiguous: string[]; // QID des classes ambiguës portées (si souverain par défaut)
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

// P31 par entité, via wbgetentities (claims complets). Renvoie les QID de classe.
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

// Libellés EN des QID de classe, pour l'affichage.
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
      reason: `marqueur subordonné « ${SUBORDINATE_CLASSES[sub]} » (${sub})`,
      ambiguous: [],
    };
  }
  const ambiguous = types.filter((t) => AMBIGUOUS_CLASSES[t]);
  return {
    tier: "SOUVERAIN",
    viaOverride: false,
    reason: types.length
      ? "défaut souverain (aucun marqueur subordonné)"
      : "aucun P31",
    ambiguous,
  };
}

async function main() {
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
  console.log(`${entities.length} entités kind='polity' (actives)\n`);

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
      const cls = classify(t);
      rows.push({
        qid: e.qid,
        label: e.label,
        types: t,
        usage: e.usage,
        ...cls,
      });
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  // Libellés des classes pour l'affichage.
  const labels = await fetchLabels([...classFreq.keys()]);
  const lbl = (q: string) => labels.get(q) ?? q;

  const sub = rows.filter((r) => r.tier === "SUBORDONNÉ");
  const sov = rows.filter((r) => r.tier === "SOUVERAIN");
  const sovOverride = sov.filter((r) => r.viaOverride);
  const sovDefault = sov.filter((r) => !r.viaOverride);
  const used = (list: Row[]) => list.filter((r) => r.usage > 0).length;

  // ── Tableau de fréquence des classes (piloter les listes) ─────────────────
  const bucketOf = (q: string) =>
    SOVEREIGN_OVERRIDE[q]
      ? "OVERRIDE"
      : SUBORDINATE_CLASSES[q]
        ? "SUBORDONNÉ"
        : AMBIGUOUS_CLASSES[q]
          ? "AMBIGU"
          : q === "Q3024240"
            ? "bruit"
            : "—";
  console.log(`Classes P31 rencontrées (${classFreq.size})\n${"─".repeat(72)}`);
  console.log(`  ${"classe".padEnd(42)} ${"QID".padEnd(12)} n     seau`);
  for (const [q, n] of [...classFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)) {
    console.log(
      `  ${lbl(q).slice(0, 40).padEnd(42)} ${q.padEnd(12)} ${String(n).padStart(4)}  ${bucketOf(q)}`,
    );
  }
  if (classFreq.size > 60)
    console.log(`  … (${classFreq.size - 60} classes de plus, voir --json)`);

  // ── SUBORDONNÉS utilisés : ce que le hull VA sauter (à vérifier) ──────────
  const subUsed = sub
    .filter((r) => r.usage > 0)
    .sort((a, b) => b.usage - a.usage);
  console.log(
    `\nSUBORDONNÉS à usage > 0 — le hull les sautera (${subUsed.length})\n${"─".repeat(72)}`,
  );
  for (const r of subUsed) {
    console.log(
      `  ${r.label.slice(0, 42).padEnd(44)} ${r.qid.padEnd(12)} usage:${String(r.usage).padStart(4)}`,
    );
    console.log(`      · ${r.reason}`);
  }

  // ── AMBIGUS utilisés : souverains par défaut portant une classe ambiguë ───
  const ambUsed = sovDefault
    .filter((r) => r.ambiguous.length && r.usage > 0)
    .sort((a, b) => b.usage - a.usage);
  console.log(
    `\nAMBIGUS à usage > 0 — souverains par défaut, à arbitrer (${ambUsed.length})\n${"─".repeat(72)}`,
  );
  for (const r of ambUsed) {
    const cls = r.ambiguous.map((q) => `${lbl(q)} (${q})`).join(", ");
    console.log(
      `  ${r.label.slice(0, 42).padEnd(44)} ${r.qid.padEnd(12)} usage:${String(r.usage).padStart(4)}`,
    );
    console.log(`      · porte : ${cls}`);
  }

  console.log(`
──────────────────────────────────────────────────────────
  total (actives)            ${rows.length}
  SOUVERAIN                  ${sov.length}   (dont ${used(sov)} utilisées)
    · via override           ${sovOverride.length}   (dont ${used(sovOverride)} utilisées)
    · par défaut             ${sovDefault.length}   (dont ${used(sovDefault)} utilisées)
  SUBORDONNÉ                 ${sub.length}   (dont ${used(sub)} utilisées)
──────────────────────────────────────────────────────────`);

  console.log(`
Lecture :
  • « SUBORDONNÉS à usage > 0 » = la liste que le hull sautera → vérifie qu'aucun
    vrai souverain ne s'y est glissé (si oui, ajoute son marqueur à l'override
    ou retire la classe fautive de la blacklist).
  • « AMBIGUS à usage > 0 » = la vraie charge résiduelle : quelques dizaines
    d'entités à trancher à la main (duché souverain vs vassal, etc.).
  Ce script n'écrit RIEN. Prochaine décision (à toi) : support du rang —
  colonne \`tier\` ou booléen \`subordinate\` sur wikidata_entities — puis
  requête hull sur la sous-séquence souveraine.`);

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
