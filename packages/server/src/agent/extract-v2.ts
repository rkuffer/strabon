// packages/server/src/agent/extract-v2.ts
// =============================================================================
// Extraction V2 — reusable module.
// Provides prompt building, referential loading, country resolution,
// timeline normalization, and rejection detection.
// Used by both the CLI test harness and the server routes.
// =============================================================================

import type { Sql } from "postgres";

// ── Country resolution (replaces COUNTRY_SHORT patch) ─────────────────────────

export async function getCountryName(
  sql: Sql<any>,
  countryQid: string | null,
): Promise<string> {
  if (!countryQid) return "";
  const rows = await sql`
    SELECT name_en FROM countries WHERE qid = ${countryQid} LIMIT 1
  `;
  return rows[0]?.name_en ?? "";
}

// ── Load referentials from wikidata_entities ──────────────────────────────────

export async function loadReferentials(sql: Sql<any>) {
  const [religions, languages, polities, cultures] = await Promise.all([
    sql`SELECT qid, label_en, family_label
        FROM wikidata_entities WHERE kind = 'religion' ORDER BY label_en`,
    sql`SELECT qid, label_en, family_label
        FROM wikidata_entities WHERE kind = 'language' ORDER BY label_en`,
    sql`SELECT qid, label_en, description_en
        FROM wikidata_entities WHERE kind = 'polity' ORDER BY label_en`,
    sql`SELECT qid, label_en, description_en
        FROM wikidata_entities WHERE kind = 'culture' ORDER BY label_en`,
  ]);

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

// ── Filiation context ─────────────────────────────────────────────────────────

export function getFiliationContext(site: any): string {
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

// ── V2 Prompt builder ─────────────────────────────────────────────────────────

export function buildPromptV2(
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

## IMPORTANT: Non-site detection

If the Wikipedia article describes something that is NOT an inhabited place or historical site
(e.g. an airport, a stadium, a building, an administrative entity, a road, a military unit,
a person, a concept), return ONLY:
{ "rejection": { "reason": "description of why this is not a site", "entity_type": "what it actually is" } }

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

## site_type defaults

If the article does not specify the site type, use "settlement" as default.
If the article does not give a founding date, infer a prudent start date from regional
context (e.g. first attested period of habitation in the region), with confidence "low"
and a note explaining the inference. NEVER use placeholder values like -99999.

## Religion and Language tracks

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

// ── Timeline normalization (V2: handles religion/language tracks) ─────────────

function normalizeSiteTypeTo(entries: any[]): any[] {
  const sorted = [...entries].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  return sorted.map((e, i) => {
    if (e.to == null) return e;
    const next = sorted[i + 1];
    if (!next) return e;
    if (e.to < next.from) return e;
    const { to, ...rest } = e;
    return rest;
  });
}

function stripTo(entries: any[]): any[] {
  return entries.map((e: any) => {
    if (e.to == null) return e;
    const { to, ...rest } = e;
    return rest;
  });
}

export function normalizeTimelineV2(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;

  let tl = raw;
  if (raw.tracks && typeof raw.tracks === "object") {
    tl = { ...raw.tracks };
  }

  const TRACK_KEYS = [
    "site_type",
    "polity",
    "culture",
    "religion",
    "language",
    "name",
    "population",
  ] as const;

  for (const key of TRACK_KEYS) {
    if (Array.isArray(tl[key])) {
      tl[key] = { entries: tl[key] };
    }
  }

  const result: any = {};
  for (const key of [...TRACK_KEYS, "events", "missing_entities"]) {
    if (tl[key] !== undefined) result[key] = tl[key];
  }

  // Strip `to` from all tracks except site_type
  for (const key of [
    "polity",
    "culture",
    "religion",
    "language",
    "name",
    "population",
  ] as const) {
    if (result[key]?.entries) {
      result[key].entries = stripTo(result[key].entries);
    }
  }

  // Normalize site_type `to` (remove redundant contiguous ones)
  if (result.site_type?.entries) {
    result.site_type.entries = normalizeSiteTypeTo(result.site_type.entries);
  }

  return result;
}

// ── Rejection and empty timeline detection ────────────────────────────────────

export function isRejection(parsed: any): { rejected: boolean; reason?: string; entityType?: string } {
  if (parsed?.rejection) {
    return {
      rejected: true,
      reason: parsed.rejection.reason ?? "Non-site detected by LLM",
      entityType: parsed.rejection.entity_type ?? "unknown",
    };
  }
  return { rejected: false };
}

export function isEmptyTimeline(timeline: any): boolean {
  const tracks = ["site_type", "polity", "culture", "religion", "language", "name", "population"];
  return tracks.every(
    (t) => !timeline[t]?.entries?.length,
  );
}
