// packages/server/src/agent/extract-v2.ts
// =============================================================================
// Extraction V2 — reusable module.
// Provides prompt building, referential loading, country resolution,
// timeline normalization, and rejection detection.
// Used by both the CLI test harness and the server routes.
//
// The prompt is a careful MERGE of the battle-tested V1 prompt (extract.ts)
// and the V2 additions: religion/language tracks with role qualifiers,
// referential-constrained QIDs, missing_entities safety net, filiation
// handling, non-site rejection, and site_type evolution rules.
// =============================================================================

import type { Sql } from "postgres";

// ── Country resolution (replaces COUNTRY_SHORT patch) ─────────────────────────

export async function getCountryInfo(
  sql: Sql<any>,
  countryQid: string | null,
): Promise<{ name: string; langCode: string | undefined }> {
  if (!countryQid) return { name: "", langCode: undefined };
  const rows = await sql`
    SELECT name_en, lang_code FROM countries WHERE qid = ${countryQid} LIMIT 1
  `;
  return {
    name: rows[0]?.name_en ?? "",
    langCode: rows[0]?.lang_code ?? undefined,
  };
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

// ── V2 Prompt builder — merged V1 foundation + V2 additions ──────────────────

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
    ? `\n## Local language source (${context.localLang})\nThe following is extracted from the ${context.localLang} Wikipedia article. It may contain additional names, dates or details not present in the English version. Use it to complement the English source.\n---\n${context.local}\n---`
    : "";

  return `You are extracting structured historical timeline data from Wikipedia articles about an inhabited place or historical site.

Site: "${title}"

## Non-site detection — check FIRST

If the Wikipedia article describes something that is NOT an inhabited place or historical
site — e.g. an airport, a stadium, an isolated building, a road or railway, a military
unit, a company, a person, an event, an abstract concept, or a purely administrative
entity distinct from any settlement — do NOT extract a timeline. Return ONLY:
{ "rejection": { "reason": "why this is not an inhabited place", "entity_type": "what it actually is" } }

A borough, district or municipality that IS the inhabited place itself (its city/town/
village) is a valid site. An administrative shell distinct from the settlement is not.

## Output format

Extract a SiteTimeline JSON object. The root object must have these keys directly (NOT wrapped in "tracks" or "site"):
{
  "site_type":  { "entries": [ { "from": number, "to"?: number, "value": string, ... } ] },
  "polity":     { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, ... } ] },
  "culture":    { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, ... } ] },
  "religion":   { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, "role": string, ... } ] },
  "language":   { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, "role": string, ... } ] },
  "name":       { "entries": [ { "from": number, "value": { "text": string, "lang": string }, ... } ] },
  "population": { "entries": [ { "from": number, "value": number, ... } ] },
  "events":     [ { "year": number, "type": string, ... } ],
  "missing_entities": [ { "kind": string, "name": string, "context": string, "proposed_qid"?: string } ]
}

## Track definitions

- **site_type**: one of: campsite, settlement, village, town, city, metropolis, capital, capital_city, religious_site, fortress, port, colony, administrative, ruins, abandoned
- **polity**: { "name": string, "wikidata": string } — the sovereign political entity controlling the site (empire, kingdom, republic, city-state...). NOT a city name, NOT a region name.
- **culture**: { "name": string, "wikidata": string } — the archaeological culture or civilisation. NOT the name of a specific city.
- **religion**: { "name": string, "wikidata": string } + "role" — a religion practiced at the site (see the dedicated section below).
- **language**: { "name": string, "wikidata": string } + "role" — a language spoken at the site (see the dedicated section below).
- **name**: { "text": string, "lang": string } — vernacular name in original script (ISO 639 lang code)
- **population**: integer
- **events**: { year, year_precision?, type, cause?, perpetrator?, perpetrator_wikidata?, description?, confidence? }
  Types: destruction, fire, earthquake, flood, plague, siege, conquest, founding, refounding, abandonment, expulsion, depopulation

Each track entry:
- "from": integer year (negative = BC)
- "to"?: integer year — OPTIONAL, **site_type track ONLY**. Marks the end of an
  occupation period before a hiatus (see the dedicated section below). NEVER use
  it on any other track, and NEVER use it for ordinary transitions.
- "from_precision"?: 6=millennium 7=century 8=decade 9=year (default 9)
- "from_circa"?: boolean
- "confidence"?: "high" | "medium" | "low"
- "sources"?: short verbatim phrases from the text
- "notes"?: string
- "role"?: string — religion and language tracks ONLY

## site_type — it MUST evolve over time

site_type describes what the place WAS at each moment of its history, as a step
function of entries. It is NOT a single static label:

- A place that begins as a prehistoric settlement and is a modern capital must show
  the progression through NEW entries as its status changes: e.g.
  settlement → village → town → city → capital_city. Each change is a new entry
  with its own "from" year.
- For a STILL-INHABITED site, the LAST site_type entry must reflect its CURRENT
  status (city, capital_city, town, village...). A living capital whose last
  site_type entry says "settlement" is WRONG.
- "settlement" is a valid value ONLY for early periods when nothing more specific
  is known — never as a lazy catch-all for the whole history.
- "archaeological site" is NEVER a valid site_type. It describes a MODERN
  classification of the place, not what the place was at any moment of its
  history. A tell that was a town in 3000 BC has site_type "town" then — and
  "ruins" or "abandoned" after its abandonment, if applicable.
- If the article does not state the earliest type or founding date, infer a prudent
  start from regional context (first attested habitation period in the region),
  mark "confidence": "low" with an explanatory note. NEVER use placeholder values
  like -99999 or "unknown".

## Religion and Language tracks — co-occurrence with roles

These two tracks support CO-OCCURRENCE: multiple entries can overlap temporally.
For any given period, list the 4-5 most significant religions/languages, each with a ROLE qualifier.

### Role qualifiers (required on every religion and language entry):
- "state": official/state religion or language (legally established or de facto official)
- "major": widely practiced/spoken by a large portion of the population
- "minor": present and notable but not dominant
- "minority": small but historically significant community

### Rules for religion/language:
- Maximum 4-5 entries per track per period. Focus on what is historically significant.
- Entries overlap: if Islam (state) and Christianity (minority) coexist, both appear, each with its own "from".
- When the religious/linguistic landscape CHANGES (e.g. a conquest introduces a new state religion, an emancipation shifts a role), emit new entries for the changed roles. Entries that continue unchanged need not be repeated.
- Role changes matter: a religion moving from "state" to "major" (e.g. after secularisation) or from "minor" to "state" (e.g. after a conversion of rulers) warrants a new entry at the transition date.
- Use ONLY the QIDs from the referential lists below for religion and language. If the religion/language is NOT in the list, DO NOT invent a QID — add it to "missing_entities" and include the timeline entry with "name" only.

### RELIGION referential — use ONLY these QIDs:
${refs.religions}

### LANGUAGE referential — use ONLY these QIDs:
${refs.languages}

## Wikidata QID rules — CRITICAL

The "wikidata" field for polity and culture entries MUST be the QID of the ENTITY ITSELF.

### POLITY QIDs — use these exact QIDs when applicable:
${refs.polities}

If the polity is not in this list, look up its actual Wikidata QID from your knowledge and use it.
If you cannot find a Wikidata QID, omit the "wikidata" field entirely (the entry will still appear in the timeline).
NEVER invent a QID. NEVER use a "local_" identifier.
NEVER use the QID of a city, a region, or a person as a polity QID.

### CULTURE QIDs — use these exact QIDs when applicable:
${refs.cultures}

If the culture is not in this list, look up its actual Wikidata QID from your knowledge and use it.
If you cannot find a Wikidata QID, omit the "wikidata" field entirely (the entry will still appear in the timeline).
NEVER use the QID of a city or a specific site as a culture QID.
NEVER assign different QIDs to the same culture across different sites — consistency is mandatory.

### QID honesty — placeholders are FORBIDDEN

A WRONG QID is worse than NO QID: it silently pollutes the shared reference tables
and merges distinct historical entities. Therefore:

- If you are not genuinely confident of the EXACT QID for an entity, OMIT the
  "wikidata" field entirely. The entry still appears in the timeline by its "name"
  alone. Omission is the CORRECT answer here, never a failure.
- NEVER insert a "placeholder", "broad", or "approximate" QID. If you find yourself
  about to write a note like "QID X used as a broad/placeholder reference" or "no
  specific QID, using Y instead" — STOP and omit the "wikidata" field instead. Such
  a note is proof that the QID is wrong.
- NEVER reuse the same QID for two different entities. Do NOT, for example, use the
  Kingdom of France QID for the First Empire, or a country's QID for a culture. If
  two entries would carry the same QID but are different entities, at least one is
  wrong — omit it.
- A country QID (e.g. France = Q142) denotes the polity "France" ONLY. It is NEVER
  a culture QID, and NEVER the QID of a historical regime (a Republic, an Empire, a
  Kingdom) — those are distinct entities with their own QIDs, or none.
- This rule is STRICTEST on inferred entries. If an entry's polity or culture comes
  from structural inference (regional context, confidence low/medium) rather than
  being read from the source, and you are not certain of its exact QID, you MUST
  omit "wikidata". Inferring the STRUCTURE never licenses inventing the QID.
- For religion and language: the referential lists above are the ONLY authorised
  QID source. An entity absent from them goes to "missing_entities" — never to an
  improvised QID, even one you believe you know.

## Missing entities — safety net for referential gaps

Whenever you need an entity (religion, language, polity, culture) that is NOT in the
referential lists above, signal it in "missing_entities" instead of forcing it into the
timeline with an uncertain QID:

{ "kind": "religion"|"language"|"polity"|"culture",
  "name": "the entity name, EXACTLY as you wrote it in the timeline entry",
  "context": "why it matters for this site",
  "proposed_qid": "Q12345"   // OPTIONAL — see below
}

Rules:
- The "name" MUST be character-for-character identical to the "name" you used in the
  timeline entry. It is the key we use to reconcile the two.
- Still include the entry in its timeline track, with "name" but WITHOUT "wikidata".
- **Do NOT signal an entity you have already resolved.** If you put a QID you are
  confident in on the timeline entry, that entity is NOT missing — say nothing about
  it. "missing_entities" is for what you could NOT resolve, not for retrospective
  second-guessing of a QID you just used. Signalling both is contradictory and creates
  noise.
- **"proposed_qid" is the RIGHT place for a QID you believe in but are not certain of.**
  This field is a HYPOTHESIS, not an assertion: it will be automatically verified
  against Wikidata (existence, type, label) before anything is done with it. A wrong
  guess here is harmless — it is checked and discarded. So if you have a plausible QID
  in mind, give it. Do NOT leave it out of prudence, and do NOT smuggle it into the
  timeline's "wikidata" field instead (there, an uncertain QID IS harmful).
  If you truly have no idea, omit "proposed_qid" entirely.
- Beware of proposing a CONTEMPORARY COUNTRY's QID for a HISTORICAL polity. "Denmark"
  (the present-day state) is not "Kingdom of Denmark" (the 19th-century monarchy);
  they are distinct entities with distinct QIDs. If the polity you need is a historical
  regime, do not fall back on the modern country's QID.
- Only signal an entity SIGNIFICANT enough to belong in a world-historical referential.
  A minor local tribe, a regional artistic style, or a sub-group with no independent
  Wikidata entity does NOT qualify. Rule of thumb: if you would not expect a dedicated
  Wikipedia article about this entity as a polity/culture/religion/language, skip it.

The division of labour is: the timeline carries only QIDs you are SURE of;
"proposed_qid" carries the ones you merely SUSPECT, for machine verification.
${filiation}
## Rules

1. Each track entry signals a CHANGE for that dimension only. Other tracks are independent.
2. Only extract what is explicitly stated or strongly implied. Do not invent dates or entities.
3. Sort each track's entries by "from" ascending.
4. CRITICAL: Each track MUST be an object with an "entries" array. Do NOT use bare arrays. Do NOT use a "tracks" wrapper.
5. Return ONLY valid JSON — no prose, no markdown fences, no comments.

## Occupation hiatus — the optional "to" field (site_type track ONLY)

By DEFAULT, do NOT set "to". Each track is a step function: an entry stays in
effect until the NEXT entry of the same track. A normal transition — a change of
type, polity, culture, or name — is modelled by letting the next entry close the
previous one, NEVER with "to". Setting "to" on an ordinary transition is WRONG
and breaks the timeline.

Set "to" ONLY on a site_type entry, and ONLY to mark an explicitly attested
occupation HIATUS: the site is abandoned/deserted at one date, THEN reoccupied
later after a gap. Model it as:
  - the site_type entry covering the occupation, with "to" = year occupation ends
  - a NEW site_type entry with "from" = year of reoccupation
The interval between "to" and the next "from" is a gap during which the site is
considered UNOCCUPIED — it disappears from the map and stops contributing to its
polity's and culture's spatial extent.

Hard rules for "to":
- A hiatus means the site was UNOCCUPIED / DESERTED / EMPTY for a period — NOT
  merely "sparsely populated", "declined", "reduced" or "in decline". A thinly
  populated site is still occupied: do NOT use "to" for it. Use "to" only when the
  source states or strongly implies the site was abandoned/deserted before being
  reoccupied later.
- NEVER set "to" equal to (or greater than) the next entry's "from". If the next
  period begins immediately — i.e. occupation is continuous even though its
  character changes — OMIT "to" entirely and let the next entry close this one.
  "to" is valid ONLY when it is strictly BEFORE the next "from", leaving a real
  unoccupied gap between them.
- Emit "to" ONLY if a later reoccupation entry exists. A site abandoned and never
  reoccupied has NO "to" — that is a dissolution, expressed by a final
  "abandoned"/"ruins" entry or an abandonment event, not by "to".
- NEVER emit "to" for mere uncertainty of attestation. "occupied/attested until X"
  with no mention of abandonment ⇒ NO "to".
- NEVER set "to" on polity, culture, religion, language, name or population.
- When you set "to", add a "notes" field citing the source for BOTH the
  abandonment and the reoccupation (same protocol as chronological corrections).

Example — a tell occupied, destroyed and deserted, then reoccupied centuries later:
  "site_type": { "entries": [
    { "from": -3000, "value": "city", "to": -1600,
      "confidence": "medium",
      "notes": "Destroyed and abandoned c. 1600 BC (source: ...)." },
    { "from": -900, "value": "town",
      "confidence": "medium",
      "notes": "Reoccupied in the Neo-Assyrian period (source: ...)." }
  ] }
Here the site is unoccupied between 1600 BC and 900 BC. The continuous case (no
abandonment) would simply omit "to" and let the -900 entry follow the -3000 one.

## Historical names vs modern city names

If the site title is an ancient/historical name of a place that still exists today
as a modern inhabited city, apply these rules:

- The **current name** (modern city name) should appear as the latest entry in the
  "name" track (with appropriate language code).
- The **ancient name(s)** should appear as earlier entries in the "name" track,
  each with their correct "from" year and language (e.g. Latin, Ancient Greek...).
- Use the modern city's Wikipedia title as reference for the current name.
- Examples:
  - "Aquae Flaviae" → modern name "Chaves" (pt), ancient name "Aquae Flaviae" (la)
  - "Londinium" → modern name "London" (en), ancient name "Londinium" (la)
  - "Lutetia" → modern name "Paris" (fr), ancient name "Lutetia" (la)
  - "Byzantium" → modern name "Istanbul" (tr), intermediate "Constantinople" (la/el)

If the site title refers to a site that is purely archaeological with no modern
inhabited successor (e.g. Pompeii, Carthage ruins, Ugarit), do NOT invent a
modern name — just document the historical names in the "name" track.

### Maximise distinct name forms (improves searchability)

Capture as MANY distinct, well-attested name forms as you reasonably can across
languages and eras — the "name" track also feeds a name search index, so a missing
form makes the site unfindable under that name.

In particular, do not omit:
- **Modern vernacular exonyms of an ancient name**: the common modern form, in a
  major language, OF THE ANCIENT NAME, when it differs from BOTH the ancient form
  AND the modern city name. Examples: "Lutèce" (fr) for Lutetia; "Trèves" (fr) for
  Augusta Treverorum; "Carthage" (en/fr) for Carthago; "Mycènes" (fr) for Mycenae.
- **Notable cross-language variants of the current name** when they differ beyond
  trivial spelling (e.g. "Florence" en / "Firenze" it / "Florenz" de).

Placement: add each variant as its own "name" entry, using the "from" year of the
name period it belongs to (a modern exonym of an ancient name takes that ancient
name's "from"), with a "notes" field stating it is a modern vernacular exonym or a
cross-language variant. Use "confidence" honestly: a well-established exonym is
"high"/"medium"; do NOT fabricate transliterations or obscure forms you are unsure
of — only include name forms you actually know to be real.

## Epistemological caution for ancient polities

When extracting polity entries for periods before 800 BC, apply extra scrutiny.
If the polity's existence derives primarily from religious texts (Bible, Vedas,
Homer, Chinese classical sources) rather than from archaeology or contemporary
inscriptions, either:
  (a) use a more modest name reflecting what is archaeologically attested
      (e.g. "Iron Age Judahite chiefdom" instead of "United Kingdom of Israel"), or
  (b) omit the polity entry and note the uncertainty in the "notes" field.

This applies especially to:
- "United Kingdom of Israel" / "Kingdom of David" → prefer "Kingdom of Judah"
  (Q170509) after 930 BC, "Kingdom of Israel" (Q160016) for northern sites
- "Canaan" as a unified polity → use individual city-state names or omit
- "Kingdom of Troy" → use "Bronze Age Anatolian polity" or omit
- Early Roman Kingdom before 600 BC → treat with low confidence
- Vedic kingdoms of India before 600 BC → treat with low confidence
- Xia dynasty China → treat with low confidence, note the debate

The same caution applies to the religion and language tracks in deep antiquity:
attribute only what archaeology or contemporary sources support, at the precision
they support (e.g. "Canaanite religion" rather than a specific cult you cannot
attest), and mark low confidence.

## Cross-check with your training knowledge

Wikipedia is your primary source, but it can contain errors, oversimplifications,
or anachronisms. After extracting from the text, validate each entry against your
historical and archaeological knowledge. Apply the following corrections silently
when the evidence is unambiguous, and record your reasoning in the "notes" field:

### Chronological hard limits — never extract dates outside these bounds:

- **Phoenician culture**: cannot predate 1200 BC. Earlier entries must use
  "Canaanite culture".
- **Greek colonisation**: cannot predate 775 BC for western Mediterranean sites,
  750 BC for most others.
- **Roman presence**: cannot predate 753 BC (founding), realistically 500 BC
  outside Italy, 200 BC for most of the western Mediterranean.
- **Islamic conquest**: well-documented — if Wikipedia implies an implausible date,
  use the historically established date and note the discrepancy. Islam itself
  cannot predate 610 AD anywhere.
- **Byzantine period**: begins 330 AD (refounding of Constantinople), not before.
- **Ottoman Empire**: cannot predate 1299 AD.
- **Christianity**: cannot predate ~30 AD anywhere, and its spread is
  well-documented — be wary of anachronistically early christianisation dates.
- **Neolithic cultures**: cannot postdate 3000 BC in the Near East,
  2500 BC in Europe (region-dependent — use your knowledge).
- **Bronze Age**: roughly 3300–1200 BC (Near East), 3200–800 BC (Europe).
  Do not assign Bronze Age culture labels outside these windows.

### Correction protocol:

When Wikipedia implies a date or entity that violates these limits:
1. Correct the "from" year to the historically attested value.
2. Set "confidence": "medium" or "low" as appropriate.
3. Add a "notes" field explaining the correction.
4. Do NOT silently accept an impossible date — always correct and note it.

### What NOT to correct:

- Do not "improve" dates that are simply uncertain or debated.
- Do not impose your knowledge over local archaeological specificity.
- Do not invent corrections — only apply them when the error is clear and
  the correct value is well-established.

## Track continuity and structural inference (polity, culture, religion, language)

Wikipedia under-documents recent and "obvious" periods. Two consequences to fix:

1. For a site that is STILL INHABITED today, the "polity" and "culture" tracks must
   not stop at some medieval or early-modern entry and then implicitly run
   unchanged to the present. A living site always has a governing polity and a
   cultural context up to today. Continue both tracks forward to the present using
   the well-established political and cultural history of its country/region — e.g.
   a French town's polity continues Kingdom of France → the Revolutionary and
   Napoleonic states → modern France, and its culture continues medieval →
   early-modern → modern French culture. The same applies to site_type: bring it
   to the site's current status.

2. You MAY infer this forward (and backward) continuity from the general history of
   the region even when the article does not state it for THIS specific site.

The religion and language tracks may use the same structural inference, with the
same constraints: the dominant religion/language of a well-documented region and
period may be attributed to a site of that region (e.g. a 12th-century French
town: Catholic Church "state", Old French/Occitan "major"), marked
"confidence": "low"/"medium" with a note. But NEVER infer minority communities:
the presence of a specific minority at a specific site (a Jewish community, an
Armenian quarter...) is site-specific DETAIL requiring attestation.

SCOPE — read carefully. This is the single, scoped exception to Rule 2 ("only what
is attested"), and it is tightly bounded:
- It applies ONLY to the structural continuity of the **polity**, **culture**,
  **religion** and **language** tracks: which broad political entity, cultural
  sphere, dominant religion and dominant language a place belonged to.
- Every inferred entry MUST be marked "confidence": "low" (or "medium" at best, when
  the regional framework is very firm) and carry a "notes" field saying it is
  inferred from regional context, not attested for this site specifically.
- It must NOT be used to invent any site-SPECIFIC detail: never infer a founding
  date, a population figure, an event, a minority community, or a precise name from
  general knowledge. Those remain strictly attestation-governed.
- It does NOT override the "Epistemological caution for ancient polities" above: do
  not infer ancient or contested polities (pre-800 BC, religiously-derived, etc.).
  Structural inference is mainly about filling FORWARD to the present for
  well-documented regions, not inventing deep-antiquity structure.
- If the region/period is itself poorly understood, so that even general knowledge
  cannot give a reliable framework, do NOT fabricate a trame: leave the track at its
  last attested entry and note the uncertainty. Honest gaps beat invented continuity.

Rule of thumb: infer the STRUCTURE, never the DETAIL.

## Population — sampling and historical depth

The population track shows a broad demographic trajectory on a deep-time atlas; it
is NOT for reproducing census tables. Apply deliberate sampling:

- Do NOT transcribe dense modern census series (annual or 5-yearly figures). They
  add volume without value here. Collapse them to a few representative anchors —
  typically one early-modern figure, one industrial-era peak or trough, and one
  recent plateau.
- Add a population entry only when it is meaningful: roughly one anchor per major
  historical period, PLUS any point marking a significant change (about ±25-30% or
  more) from the previous recorded figure, or a notable peak/collapse (e.g. after a
  plague or a war). A stable stretch needs a single point, not many.
- Actively PRIORITISE ancient and pre-modern estimates: a single figure for a
  classical, medieval or early-modern population is FAR more valuable to this
  project than any number of recent census rows. If the sources mention such an
  estimate, even an isolated or rough one, capture it (with appropriate "confidence"
  and a "notes" range if the source gives one).
- This is SAMPLING, not invention. Population is site-specific DETAIL: only use
  figures actually present in the sources. NEVER infer or fabricate a population
  number from general knowledge — the structural-inference exception above does NOT
  apply to population.

## Wikipedia sources
${context.local ? `Two sources are provided: the English article (primary) and a local language article (${context.localLang}, supplementary). Prefer the English source for dates and political entities; use the local source primarily for vernacular names and any additional historical details it provides.` : ""}

### English article (pre-filtered to historical sections)
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

  // Pass through rejection objects untouched
  if (raw.rejection) return raw;

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

export function isRejection(parsed: any): {
  rejected: boolean;
  reason?: string;
  entityType?: string;
} {
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
  const tracks = [
    "site_type",
    "polity",
    "culture",
    "religion",
    "language",
    "name",
    "population",
  ];
  return tracks.every((t) => !timeline[t]?.entries?.length);
}
