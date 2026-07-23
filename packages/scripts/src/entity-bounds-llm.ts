// =============================================================================
// entity-bounds-llm.ts
// -----------------------------------------------------------------------------
// Complète les bornes chronologiques des entités du référentiel que Wikidata ne
// date PAS.
//
// Pourquoi cette passe existe
// ---------------------------
// entity-bounds-sparql.ts couvre les entités dotées de P571/P576/P580/P582.
// Mesure faite sur les cultures archéologiques (juillet 2026) : 2 bornes
// exploitables sur 12 entités testées — et les deux hors plage humaine. Pour les
// cultures, la voie SPARQL est une impasse. Sans bornes, une attribution de hull
// s'affiche à TOUTE époque (constaté : « Islamic culture » rendue en 8000 BC).
//
// Pourquoi le LLM est légitime ICI, alors qu'il dérape en extraction
// ------------------------------------------------------------------
// « Quand commence et finit la culture de Hallstatt ? » est une question
// encyclopédique FERMÉE, à réponse courte et stable, très différente de
// l'extraction ouverte d'une chronologie complète depuis un article. C'est le
// registre où le modèle est fiable.
//
// PRÉCISION — le point qui compte
// -------------------------------
// Les bornes portent une précision, même vocabulaire que les entrées de timeline
// (héritage de timePrecision Wikidata) : 6=millénaire, 7=siècle, 8=décennie,
// 9=année. Ce n'est pas décoratif : applyEntityBounds propage l'imprécision sur
// les entrées qu'il raccourcit (from_circa + from_precision). Une culture
// archéologique est intrinsèquement floue — exiger une année sèche fabriquerait
// une fausse précision. Le prompt impose donc le siècle par défaut.
//
// Écrit bounds_source='llm', bounds_confirmed=false. Décision de Rodolphe : ces
// bornes sont exploitées DIRECTEMENT (hulls et timelines), sans étape de
// confirmation — d'où l'export systématique et le signalement automatique des
// résultats douteux ci-dessous, à relire AVANT de reprendre les extractions.
//
// Usage :
//   ANTHROPIC_API_KEY=... DATABASE_URL=... \
//     npx -y tsx packages/scripts/src/entity-bounds-llm.ts --kind culture --dry-run
//   ANTHROPIC_API_KEY=... DATABASE_URL=... \
//     npx -y tsx packages/scripts/src/entity-bounds-llm.ts --kind culture
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

// Question fermée et courte : on peut en grouper beaucoup par appel sans
// dégrader la réponse, et ça divise le coût d'autant.
const BATCH_SIZE = 25;

// Plage humaine, alignée sur entity-bounds-sparql.ts.
const MIN_YEAR = -200_000;
const MAX_YEAR = 2_100;

type Target = {
  qid: string;
  kind: string;
  label_en: string;
  description_en: string | null;
};

type LlmBound = {
  qid: string;
  inception: number | null;
  inception_precision: number | null;
  dissolution: number | null;
  dissolution_precision: number | null;
  note?: string;
};

const PROMPT_HEAD = `You date historical and archaeological entities. For each entity below, give its chronological bounds.

Return ONLY a JSON array, no prose, no markdown fence:
[{"qid":"Q…","inception":-1200,"inception_precision":7,"dissolution":-450,"dissolution_precision":7,"note":"…"}]

Rules:

1. YEARS are historiographical integers. Negative = BC, positive = AD. There is NO year zero.

2. PRECISION is mandatory with every non-null year:
     9 = year      (a securely dated event)
     8 = decade
     7 = century   ← DEFAULT for archaeological cultures and prehistoric entities
     6 = millennium
   Archaeological cultures have fuzzy, debated boundaries. Claiming year precision
   for one is a factual error. Use 9 only when the date is genuinely fixed by a
   documented event (a treaty, a founding, a conquest).

3. If you do not know a bound, return null for BOTH that year and its precision.
   An honest null is far better than a guess: these bounds are applied directly,
   and a wrong one silently truncates real data.

4. inception must be strictly earlier than dissolution.

5. Some entities are ETHNIC GROUPS or PEOPLES rather than archaeological cultures
   (e.g. "Gauls", "Thracians"). Date the period during which the group is
   attested as such in the sources — not the entire span of its descendants.

6. note: one short clause only when something is genuinely contested or when you
   returned nulls. Leave it out otherwise.`;

function buildPrompt(batch: Target[]): string {
  const lines = batch.map(
    (t) =>
      `${t.qid} | ${t.label_en}${t.description_en ? ` — ${t.description_en}` : ""} [kind: ${t.kind}]`,
  );
  return `${PROMPT_HEAD}\n\nEntities:\n${lines.join("\n")}`;
}

/** Tolère une réponse enrobée de prose ou de fences : prend le dernier tableau. */
function extractJsonArray(text: string): any[] | null {
  const fenced = text.replace(/```(?:json)?/g, "");
  const start = fenced.lastIndexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── Contrôles DÉTERMINISTES ─────────────────────────────────────────────────
// Pas de jugement sur le fond : uniquement des contradictions vérifiables et des
// invraisemblances de forme. Tout le reste est rendu brut, à ta lecture.
function anomalies(b: LlmBound, t: Target): string[] {
  const out: string[] = [];
  const { inception: i, dissolution: d } = b;

  for (const [name, y] of [
    ["inception", i],
    ["dissolution", d],
  ] as const) {
    if (y != null && (y < MIN_YEAR || y > MAX_YEAR)) {
      out.push(`${name} ${y} hors plage humaine`);
    }
  }

  if (i != null && d != null) {
    if (i >= d) out.push(`inception ${i} ≥ dissolution ${d}`);
    else {
      const span = d - i;
      if (span < 10) out.push(`durée ${span} ans — invraisemblablement courte`);
      if (span > 20_000) out.push(`durée ${span} ans — invraisemblablement longue`);
    }
  }

  // Fausse précision : année revendiquée sur une entité clairement préhistorique.
  for (const [name, y, p] of [
    ["inception", i, b.inception_precision],
    ["dissolution", d, b.dissolution_precision],
  ] as const) {
    if (y != null && p === 9 && y < -1000) {
      out.push(`${name}: précision ANNÉE revendiquée en ${y}`);
    }
    if (y != null && p == null) out.push(`${name}: précision manquante`);
    if (y == null && p != null) out.push(`${name}: précision sans année`);
  }

  if (i == null && d == null) out.push("aucune borne trouvée");
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const kindFilter = args.includes("--kind")
    ? args[args.indexOf("--kind") + 1]
    : null;
  const outPath = args.includes("--out")
    ? args[args.indexOf("--out") + 1]
    : "entity-bounds-llm.json";

  const sql = getSql();
  const anthropic = new Anthropic();

  const targets = await sql<Target[]>`
    SELECT qid, kind, label_en, description_en
    FROM wikidata_entities
    WHERE bounds_source IS NULL
      ${kindFilter ? sql`AND kind = ${kindFilter}` : sql``}
    ORDER BY kind, label_en
  `;

  console.log(
    `${targets.length} entités sans bornes${kindFilter ? ` (kind=${kindFilter})` : ""}` +
      `${dryRun ? "  [DRY RUN]" : ""}\n`,
  );
  if (!targets.length) {
    await closeSql();
    return;
  }

  const results: (LlmBound & { label: string; kind: string; flags: string[] })[] =
    [];
  let written = 0;
  let missing = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    process.stderr.write(
      `\r  lot ${Math.min(i + BATCH_SIZE, targets.length)}/${targets.length}…`,
    );

    let parsed: any[] | null = null;
    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: buildPrompt(batch) }],
      });
      const text = res.content
        .map((c: any) => (c.type === "text" ? c.text : ""))
        .join("");
      parsed = extractJsonArray(text);
      if (!parsed) {
        console.error(`\n  ⚠ lot ${i}: réponse non parsable\n${text.slice(0, 300)}`);
      }
    } catch (err: any) {
      console.error(`\n  ⚠ lot ${i} échoué : ${err?.message}`);
    }
    if (!parsed) continue;

    const byQid = new Map(batch.map((t) => [t.qid, t]));
    for (const raw of parsed) {
      const t = byQid.get(raw?.qid);
      if (!t) continue; // QID inventé ou hors lot : ignoré

      const b: LlmBound = {
        qid: t.qid,
        inception: typeof raw.inception === "number" ? raw.inception : null,
        inception_precision:
          typeof raw.inception_precision === "number"
            ? raw.inception_precision
            : null,
        dissolution: typeof raw.dissolution === "number" ? raw.dissolution : null,
        dissolution_precision:
          typeof raw.dissolution_precision === "number"
            ? raw.dissolution_precision
            : null,
        note: typeof raw.note === "string" ? raw.note : undefined,
      };

      const flags = anomalies(b, t);
      results.push({ ...b, label: t.label_en, kind: t.kind, flags });

      if (b.inception == null && b.dissolution == null) {
        missing++;
        continue; // rien à écrire : bounds_source reste NULL, re-tentable plus tard
      }
      if (dryRun) continue;

      await sql`
        UPDATE wikidata_entities SET
          inception             = ${b.inception},
          inception_precision   = ${b.inception_precision},
          dissolution           = ${b.dissolution},
          dissolution_precision = ${b.dissolution_precision},
          bounds_source         = 'llm',
          bounds_confirmed      = false,
          bounds_note           = ${b.note ?? null},
          bounds_updated_at     = now()
        WHERE qid = ${t.qid}
      `;
      written++;
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  // ── Export : à relire AVANT de reprendre les extractions ──────────────────
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  const flagged = results.filter((r) => r.flags.length);
  const P: Record<number, string> = { 6: "millénaire", 7: "siècle", 8: "décennie", 9: "année" };
  const fmt = (y: number | null, p: number | null) =>
    y == null ? "—" : `${y < 0 ? `${-y} BC` : `${y} AD`}${p && p < 9 ? ` (${P[p] ?? p})` : ""}`;

  console.log(`Bornes obtenues (${results.length} entités) — extrait :\n`);
  for (const r of results.slice(0, 25)) {
    console.log(
      `  ${r.label.slice(0, 32).padEnd(33)} ${fmt(r.inception, r.inception_precision).padStart(20)} → ${fmt(r.dissolution, r.dissolution_precision)}`,
    );
  }

  if (flagged.length) {
    console.log(`\n⚠ ${flagged.length} RÉSULTATS À ÉVALUER :\n`);
    for (const r of flagged) {
      console.log(`  ${r.label} (${r.qid})`);
      console.log(
        `      ${fmt(r.inception, r.inception_precision)} → ${fmt(r.dissolution, r.dissolution_precision)}`,
      );
      for (const f of r.flags) console.log(`      · ${f}`);
      if (r.note) console.log(`      note: ${r.note}`);
    }
  }

  console.log(`
──────────────────────────────────────────────────────────
  entités traitées                    ${results.length}
  bornes écrites                      ${dryRun ? "0 (dry run)" : written}
  laissées sans borne par le modèle   ${missing}
  signalées à évaluer                 ${flagged.length}
  export                              ${outPath}
──────────────────────────────────────────────────────────

Relis l'export AVANT de reprendre les extractions : ces bornes sont exploitées
directement, y compris par applyEntityBounds qui raccourcit les entrées de
timeline hors bornes. Corriger une borne en base puis relancer
build-culture-attributions.ts propage la correction aux hulls.`);

  await closeSql();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
