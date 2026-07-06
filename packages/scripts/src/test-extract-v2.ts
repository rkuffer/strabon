// packages/scripts/src/test-extract-v2.ts
// =============================================================================
// Extraction V2 — CLI test harness.
// Enhanced extraction with religion/language tracks, role qualifiers,
// filiation handling, and missing entity detection.
//
// Runs on a single site, outputs the timeline JSON for inspection.
// Does NOT write to DB (review first, integrate later).
//
// Usage:
//   ANTHROPIC_API_KEY=... DATABASE_URL=... \
//     npx tsx packages/scripts/src/test-extract-v2.ts Q406       # Istanbul
//     npx tsx packages/scripts/src/test-extract-v2.ts Q1190403   # Edessa
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { getSql, getSiteById, closeSql } from "@strabon/db";
import { buildWikipediaContext } from "../../server/src/routes/admin/wikipedia.js";
import { getWikidataEntity } from "../../server/src/agent/resolution-tools.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const ROUTER_MODEL =
  process.env.ANTHROPIC_ROUTER_MODEL ?? "claude-haiku-4-5-20251001";

// ── Load referentials from wikidata_entities ──────────────────────────────────

async function loadReferentials(countryQid: string | null) {
  const sql = getSql();

  // Religions: all (78 entries — fits easily)
  const religions = await sql`
    SELECT qid, label_en, family_label
    FROM wikidata_entities WHERE kind = 'religion'
    ORDER BY label_en
  `;

  // Languages: all (130 entries — fits easily)
  const languages = await sql`
    SELECT qid, label_en, family_label
    FROM wikidata_entities WHERE kind = 'language'
    ORDER BY label_en
  `;

  // Polities: from wikidata_entities, limited to 300
  // (TODO: filter by region based on countryQid for better relevance)
  const polities = await sql`
    SELECT qid, label_en, description_en
    FROM wikidata_entities WHERE kind = 'polity'
    ORDER BY label_en
  `;

  // Cultures: from wikidata_entities, limited to 200
  const cultures = await sql`
    SELECT qid, label_en, description_en
    FROM wikidata_entities WHERE kind = 'culture'
    ORDER BY label_en
  `;

  const fmt = (rows: any[], withFamily = false) =>
    rows
      .map(
        (r: any) =>
          `  ${r.qid} = ${r.label_en}${withFamily && r.family_label ? ` [${r.family_label}]` : ""}${r.description_en ? ` (${r.description_en})` : ""}`,
      )
      .join("\n") || "  (none)";

  return {
    religions: fmt(religions, true),
    languages: fmt(languages, true),
    polities: fmt(polities),
    cultures: fmt(cultures),
    counts: {
      religions: religions.length,
      languages: languages.length,
      polities: polities.length,
      cultures: cultures.length,
    },
  };
}

// ── Load filiation info from site meta ────────────────────────────────────────

function getFiliationContext(site: any): string {
  const meta =
    typeof site.meta === "string" ? JSON.parse(site.meta) : (site.meta ?? {});
  const parts: string[] = [];

  if (meta.related_qid && meta.relation_role) {
    if (meta.relation_role === "ancient") {
      parts.push(
        `This site is the ANCIENT/EARLIER incarnation of a place. Its modern successor is ${meta.related_qid}.`,
        `Bound this site's timeline to its OWN period of existence. Do NOT extend it into the modern successor's era.`,
      );
    } else if (meta.relation_role === "modern") {
      parts.push(
        `This site is the MODERN/LATER incarnation of a place. Its ancient predecessor is ${meta.related_qid}.`,
        `Bound this site's timeline to its OWN period of existence. Do NOT replay the predecessor's ancient history.`,
      );
    }
    if (meta.relation_note) parts.push(`Context: ${meta.relation_note}`);
  }

  return parts.length ? `\n## Filiation\n${parts.join("\n")}\n` : "";
}

// ── Build the V2 prompt ───────────────────────────────────────────────────────

function buildPromptV2(
  title: string,
  context: { en: string; local: string; localLang: string },
  refs: {
    religions: string;
    languages: string;
    polities: string;
    cultures: string;
  },
  filiation: string,
): string {
  const localSection = context.local
    ? `\n## Local language source (${context.localLang})\n---\n${context.local}\n---`
    : "";

  return `You are extracting structured historical timeline data from Wikipedia articles about an archaeological site or historical city.

Site: "${title}"

## Output format

Extract a SiteTimeline JSON object with these keys:
{
  "site_type":  { "entries": [ { "from": number, "to"?: number, "value": string } ] },
  "polity":     { "entries": [ { "from": number, "value": { "name": string, "wikidata": string } } ] },
  "culture":    { "entries": [ { "from": number, "value": { "name": string, "wikidata": string } } ] },
  "religion":   { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, "role": string } ] },
  "language":   { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, "role": string } ] },
  "name":       { "entries": [ { "from": number, "value": { "text": string, "lang": string } } ] },
  "population": { "entries": [ { "from": number, "value": number } ] },
  "events":     [ { "year": number, "type": string } ],
  "missing_entities": [ { "kind": string, "name": string, "context": string } ]
}

## NEW: Religion and Language tracks

These two tracks support CO-OCCURRENCE: multiple entries can overlap temporally.
For any given period, list the 4-5 most significant religions/languages, each with a ROLE qualifier.

### Role qualifiers (required on every religion and language entry):
- "state": official/state religion or language (legally established)
- "major": widely practiced/spoken by a large portion of the population
- "minor": present and notable but not dominant
- "minority": small but historically significant community

### Rules for religion/language:
- Maximum 4-5 entries per track per period. Focus on what's historically significant.
- Entries overlap: if Islam (state) and Christianity (minority) coexist, both appear with the same "from".
- When the religious/linguistic landscape CHANGES (e.g. a conquest introduces a new state religion), emit new entries for the changed roles. Previous entries that continue unchanged need not be repeated.
- Use the QIDs from the referential lists below. If the religion/language is NOT in the list, DO NOT invent a QID — instead add it to "missing_entities".

### RELIGION referential — use ONLY these QIDs:
${refs.religions}

### LANGUAGE referential — use ONLY these QIDs:
${refs.languages}

## POLITY referential — use these QIDs when applicable:
${refs.polities}

If the polity is not in this list, look up its actual Wikidata QID from your knowledge.
If uncertain, omit the "wikidata" field entirely. NEVER invent a QID.

## CULTURE referential — use these QIDs when applicable:
${refs.cultures}

Same rules as polity: if not in the list, use your knowledge or omit.

## Missing entities — CRITICAL SAFETY NET

If you want to mention a religion, language, polity, or culture that is NOT in the referential lists above and you cannot find a confident QID:
- Do NOT hallucinate a QID
- Add it to the "missing_entities" array: { "kind": "religion"|"language"|"polity"|"culture", "name": "the entity name", "context": "why it's relevant" }
- Still include the entry in the timeline track with the "name" field but WITHOUT "wikidata"
- Only signal a missing entity if it is SIGNIFICANT enough to warrant its own entry in a world-historical referential. A minor local tribe, a regional artistic style, or a sub-group with no independent Wikidata entity does NOT qualify. Rule of thumb: if you would not expect to find a dedicated Wikipedia article about this entity as a polity/culture/religion/language, do not signal it.

This lets us detect gaps in the referential and enrich it incrementally.
${filiation}
## Track entry format

Each entry:
- "from": integer year (negative = BC)
- "to"?: integer year — site_type track ONLY, for occupation hiatuses
- "from_precision"?: 6=millennium 7=century 8=decade 9=year (default 9)
- "from_circa"?: boolean
- "confidence"?: "high" | "medium" | "low"
- "sources"?: short verbatim phrases
- "notes"?: string
- "role"?: string — religion and language tracks ONLY

## Occupation hiatus — "to" field (site_type track ONLY)

Set "to" ONLY on site_type entries to mark an explicitly attested occupation HIATUS (site abandoned then reoccupied later). NEVER on other tracks. A normal transition has no "to" — the next entry closes the previous one.

## Wikidata QID rules — CRITICAL

- A WRONG QID is worse than NO QID. If unsure, OMIT "wikidata" entirely.
- NEVER use placeholder or approximate QIDs.
- NEVER reuse the same QID for different entities.
- A country QID is NEVER a culture QID, and NEVER a historical regime's QID.
- For religion and language: use ONLY QIDs from the referential lists above. If not found there → missing_entities.

## Historical names

Capture as many distinct name forms as possible (improves searchability):
- Ancient names, medieval names, modern names
- Cross-language variants (Florence/Firenze/Florenz)
- Modern vernacular exonyms of ancient names (Lutèce for Lutetia, Trèves for Augusta Treverorum)

## Epistemological caution (pre-800 BC polities)

Apply extra scrutiny to polities derived from religious texts rather than archaeology. Use modest names reflecting archaeological evidence. Mark low confidence.

## Chronological hard limits

- Phoenician culture: not before 1200 BC (use Canaanite before)
- Greek colonisation: not before 775 BC western Med, 750 BC elsewhere
- Roman presence: not before 500 BC outside Italy
- Byzantine period: begins 330 AD
- Ottoman Empire: not before 1299 AD

## Track continuity

For still-inhabited sites, continue polity and culture tracks forward to the present. Mark inferred entries "confidence": "low" with notes.

## Population sampling

One anchor per major period. Prioritise ancient/pre-modern estimates. Do not transcribe dense modern census series.

## Sources
${context.local ? `English (primary) and local (${context.localLang}, supplementary).` : "English article only."}

### English article
---
${context.en}
---
${localSection}

Return ONLY valid JSON — no prose, no markdown fences.`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const siteId = process.argv[2];
  if (!siteId) {
    console.error("Usage: test-extract-v2.ts <site_id>");
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });
  const sql = getSql();

  // Load site
  const site = (await getSiteById(siteId)) as any;
  if (!site) {
    console.error(`Site ${siteId} not found`);
    process.exit(1);
  }
  console.log(`\n=== Extract V2: ${site.title_en} (${siteId}) ===\n`);

  // Load referentials
  console.log("[v2] Loading referentials...");
  const refs = await loadReferentials(site.country_qid);
  console.log(
    `[v2] Referentials: ${refs.counts.polities} polities, ${refs.counts.cultures} cultures, ${refs.counts.religions} religions, ${refs.counts.languages} languages`,
  );

  // Build Wikipedia context (reuse existing pipeline)
  console.log("[v2] Fetching Wikipedia context...");
  const t0 = Date.now();
  const COUNTRY_SHORT: Record<string, string> = {
    Q148: "China",
    Q79: "Egypt",
    Q43: "Turkey",
    Q159: "Russia",
    Q17: "Japan",
    Q884: "South Korea",
    Q668: "India",
    Q252: "Indonesia",
    Q36: "Poland",
    Q183: "Germany",
    Q142: "France",
    Q29: "Spain",
    Q38: "Italy",
    Q55: "Netherlands",
    Q45: "Portugal",
    Q155: "Brazil",
    Q96: "Mexico",
    Q414: "Argentina",
    Q218: "Romania",
    Q28: "Hungary",
    Q213: "Czech Republic",
    Q34: "Sweden",
    Q33: "Finland",
    Q35: "Denmark",
    Q20: "Norway",
    Q189: "Iceland",
    Q419: "Peru",
    Q739: "Colombia",
  };
  const countryName = COUNTRY_SHORT[site.country_qid] ?? site.country ?? "";
  const wikiContext = await buildWikipediaContext(
    site.wikidata_id,
    countryName,
    site.title_en,
    client,
    ROUTER_MODEL,
  );
  console.log(
    `[v2] Wikipedia context: ${wikiContext.en.length} chars EN, ${wikiContext.local.length} chars ${wikiContext.localLang || "none"} (${Date.now() - t0}ms)`,
  );

  if (!wikiContext.en && !wikiContext.local) {
    console.error("[v2] No Wikipedia content found");
    process.exit(1);
  }

  // Filiation
  const filiation = getFiliationContext(site);
  if (filiation) console.log("[v2] Filiation context injected");

  // Build prompt
  const prompt = buildPromptV2(site.title_en, wikiContext, refs, filiation);
  console.log(`[v2] Prompt: ${prompt.length} chars`);

  // Call Claude
  console.log(`[v2] Calling ${MODEL}...`);
  const t1 = Date.now();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  console.log(`[v2] Response: ${raw.length} chars (${Date.now() - t1}ms)`);

  // Parse
  let timeline: any;
  const outFile = `extract-v2-${siteId}.json`;
  const fs = await import("fs");
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    timeline = JSON.parse(cleaned);
  } catch {
    // Write raw output for debugging even on parse failure
    fs.writeFileSync(outFile, raw);
    console.error(`[v2] FAILED to parse JSON. Raw output saved to ${outFile}`);
    console.error(
      `[v2] Likely cause: output truncated (${raw.length} chars). Check max_tokens or reduce prompt size.`,
    );
    await closeSql();
    process.exit(1);
  }

  // Display results
  console.log(`\n=== Timeline for ${site.title_en} ===\n`);

  for (const track of [
    "site_type",
    "polity",
    "culture",
    "religion",
    "language",
    "name",
    "population",
  ]) {
    const entries = timeline[track]?.entries ?? [];
    if (entries.length === 0) continue;
    console.log(`── ${track} (${entries.length} entries) ──`);
    for (const e of entries) {
      const from = e.from_circa ? `c.${e.from}` : e.from;
      const to = e.to ? `→${e.to}` : "";
      const role = e.role ? ` [${e.role}]` : "";
      let val = "";
      if (typeof e.value === "object" && e.value !== null) {
        val = e.value.name || e.value.text || JSON.stringify(e.value);
        if (e.value.wikidata) val += ` (${e.value.wikidata})`;
        if (e.value.lang) val += ` [${e.value.lang}]`;
      } else {
        val = String(e.value);
      }
      const conf =
        e.confidence && e.confidence !== "high" ? ` {${e.confidence}}` : "";
      console.log(`  ${from}${to}: ${val}${role}${conf}`);
    }
    console.log();
  }

  // Events
  const events = timeline.events ?? [];
  if (events.length) {
    console.log(`── events (${events.length}) ──`);
    for (const ev of events) {
      console.log(
        `  ${ev.year}: ${ev.type}${ev.description ? " — " + ev.description : ""}`,
      );
    }
    console.log();
  }

  // Missing entities
  const missing = timeline.missing_entities ?? [];
  if (missing.length) {
    console.log(
      `── ⚠ MISSING ENTITIES (${missing.length}) — not in referential ──`,
    );
    for (const m of missing) {
      console.log(`  [${m.kind}] ${m.name}: ${m.context}`);
    }
    console.log();
  } else {
    console.log("── No missing entities reported ──\n");
  }

  // Write full JSON for review
  fs.writeFileSync(outFile, JSON.stringify(timeline, null, 2));
  console.log(`Full timeline written to ${outFile}\n`);

  await closeSql();
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
