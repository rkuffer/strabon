// packages/server/src/routes/admin/extract.ts
import type { FastifyPluginAsync } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { getSql, getSiteById, syncReferentialsFromTimeline } from "@strabon/db";
import {
  computeInceptionFromTimeline,
  computeDissolutionFromTimeline,
} from "@strabon/shared";
import type { SiteTimeline } from "@strabon/shared";
import { buildWikipediaContext } from "./wikipedia.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const ROUTER_MODEL =
  process.env.ANTHROPIC_ROUTER_MODEL ?? "claude-haiku-4-5-20251001";

// ── Client Anthropic (singleton par requête) ──────────────────────────────────

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");
  return new Anthropic({ apiKey });
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(
  title: string,
  context: { en: string; local: string; localLang: string },
  knownPolities: string,
  knownCultures: string,
): string {
  const localSection = context.local
    ? `\n## Local language source (${context.localLang})\nThe following is extracted from the ${context.localLang} Wikipedia article. It may contain additional names, dates or details not present in the English version. Use it to complement the English source.\n---\n${context.local}\n---`
    : "";

  return `You are extracting structured historical timeline data from Wikipedia articles about an archaeological site or historical city.

Site: "${title}"

## Output format

Extract a SiteTimeline JSON object. The root object must have these keys directly (NOT wrapped in "tracks" or "site"):
{
  "site_type":  { "entries": [ { "from": number, "to"?: number, "value": string, ... } ] },
  "polity":     { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, ... } ] },
  "culture":    { "entries": [ { "from": number, "value": { "name": string, "wikidata": string }, ... } ] },
  "name":       { "entries": [ { "from": number, "value": { "text": string, "lang": string }, ... } ] },
  "population": { "entries": [ { "from": number, "value": number, ... } ] },
  "events":     [ { "year": number, "type": string, ... } ]
}

## Track definitions

- **site_type**: one of: campsite, settlement, village, town, city, metropolis, capital, capital_city, religious_site, fortress, port, colony, administrative, ruins, abandoned
- **polity**: { "name": string, "wikidata": string } — the sovereign political entity controlling the site (empire, kingdom, republic, city-state...). NOT a city name, NOT a region name.
- **culture**: { "name": string, "wikidata": string } — the archaeological culture or civilisation. NOT the name of a specific city.
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

## Wikidata QID rules — CRITICAL

The "wikidata" field for polity and culture entries MUST be the QID of the ENTITY ITSELF.

### POLITY QIDs — use these exact QIDs when applicable:
${knownPolities}

If the polity is not in this list, look up its actual Wikidata QID from your knowledge and use it.
If you cannot find a Wikidata QID, omit the "wikidata" field entirely (the entry will still appear in the timeline).
NEVER invent a QID. NEVER use a "local_" identifier.
NEVER use the QID of a city, a region, or a person as a polity QID.

### CULTURE QIDs — use these exact QIDs when applicable:
${knownCultures}

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
- NEVER set "to" on polity, culture, name or population.
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
  use the historically established date and note the discrepancy.
- **Byzantine period**: begins 330 AD (refounding of Constantinople), not before.
- **Ottoman Empire**: cannot predate 1299 AD.
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

## Track continuity and structural inference (polity & culture)

Wikipedia under-documents recent and "obvious" periods. Two consequences to fix:

1. For a site that is STILL INHABITED today, the "polity" and "culture" tracks must
   not stop at some medieval or early-modern entry and then implicitly run
   unchanged to the present. A living site always has a governing polity and a
   cultural context up to today. Continue both tracks forward to the present using
   the well-established political and cultural history of its country/region — e.g.
   a French town's polity continues Kingdom of France → the Revolutionary and
   Napoleonic states → modern France, and its culture continues medieval →
   early-modern → modern French culture.

2. You MAY infer this forward (and backward) continuity from the general history of
   the region even when the article does not state it for THIS specific site.

SCOPE — read carefully. This is the single, scoped exception to Rule 2 ("only what
is attested"), and it is tightly bounded:
- It applies ONLY to the structural continuity of the **polity** and **culture**
  tracks: which broad political entity and cultural sphere a place belonged to.
- Every inferred entry MUST be marked "confidence": "low" (or "medium" at best, when
  the regional framework is very firm) and carry a "notes" field saying it is
  inferred from regional context, not attested for this site specifically.
- It must NOT be used to invent any site-SPECIFIC detail: never infer a founding
  date, a population figure, an event, a site_type change, or a precise name from
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
${localSection}`;
}

// ── Normalisation du format retourné par le LLM ──────────────────────────────

// Normalise les `to` de la piste site_type.
// Un `to` n'encode un hiatus QUE s'il est strictement avant le `from` de l'entrée
// suivante. Sinon (contigu `to == next.from`, ou chevauchant `to > next.from`) il
// est redondant : on le retire pour que `to` ne signifie QUE de vrais trous.
// Un `to` sur la dernière entrée est conservé (dissolution terminale).
function normalizeSiteTypeTo(entries: any[]): any[] {
  const sorted = [...entries].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  return sorted.map((e, i) => {
    if (e.to == null) return e;
    const next = sorted[i + 1];
    if (!next) return e; // dernière entrée : to = dissolution terminale, on garde
    if (e.to < next.from) return e; // trou réel, on garde
    const { to, ...rest } = e; // contigu/chevauchant : on retire to
    return rest;
  });
}

// Retire tout `to` d'une piste (utilisé pour les pistes autres que site_type).
function stripTo(entries: any[]): any[] {
  return entries.map((e: any) => {
    if (e.to == null) return e;
    const { to, ...rest } = e;
    return rest;
  });
}

function normalizeTimeline(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;

  let tl = raw;
  if (raw.tracks && typeof raw.tracks === "object") {
    tl = { ...raw.tracks };
  }

  const TRACK_KEYS = [
    "site_type",
    "polity",
    "culture",
    "name",
    "population",
  ] as const;
  for (const key of TRACK_KEYS) {
    if (Array.isArray(tl[key])) {
      tl[key] = { entries: tl[key] };
    }
  }

  const result: any = {};
  for (const key of [...TRACK_KEYS, "events"]) {
    if (tl[key] !== undefined) result[key] = tl[key];
  }

  // `to` n'a de sens que sur site_type : on le retire des autres pistes (défensif).
  for (const key of ["polity", "culture", "name", "population"] as const) {
    if (result[key]?.entries) {
      result[key].entries = stripTo(result[key].entries);
    }
  }
  // Nettoyage des `to` redondants (contigus/chevauchants) sur site_type.
  if (result.site_type?.entries) {
    result.site_type.entries = normalizeSiteTypeTo(result.site_type.entries);
  }

  return result;
}

// ── Chargement des référentiels pour le prompt ────────────────────────────────

async function loadKnownEntities(): Promise<{
  polities: string;
  cultures: string;
}> {
  const sql = getSql();

  const [polities, cultures] = await Promise.all([
    sql`SELECT wikidata_id, name, type FROM polities ORDER BY name LIMIT 200`,
    sql`SELECT wikidata_id, name, type FROM cultures ORDER BY name LIMIT 200`,
  ]);

  const fmtPolities = polities.length
    ? polities
        .map(
          (p: any) =>
            `  ${p.wikidata_id} = ${p.name}${p.type ? ` (${p.type})` : ""}`,
        )
        .join("\n")
    : "  (none yet — use your knowledge)";

  const fmtCultures = cultures.length
    ? cultures
        .map(
          (c: any) =>
            `  ${c.wikidata_id} = ${c.name}${c.type ? ` (${c.type})` : ""}`,
        )
        .join("\n")
    : "  (none yet — use your knowledge)";

  return { polities: fmtPolities, cultures: fmtCultures };
}

// ── Appel Claude via SDK ──────────────────────────────────────────────────────

async function callClaude(
  prompt: string,
): Promise<{ raw: string; timeline: SiteTimeline }> {
  const client = getClient();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  let parsed: any;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new SyntaxError("Invalid JSON from model");
    console.log(raw);
  }

  const timeline = normalizeTimeline(parsed) as SiteTimeline;
  return { raw, timeline };
}

// ── Mise à jour des bornes temporelles ───────────────────────────────────────

async function updateTemporalBounds(
  sql: any,
  siteId: string,
  timeline: SiteTimeline,
) {
  const inception = computeInceptionFromTimeline(timeline);
  const dissolution = computeDissolutionFromTimeline(timeline);
  if (inception === null && dissolution === null) return;
  await sql`
    UPDATE sites SET
      inception_year   = COALESCE(${inception},   inception_year),
      dissolution_year = COALESCE(${dissolution}, dissolution_year)
    WHERE id = ${siteId}
  `;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const adminExtractRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/extract — liste des sites
  app.get<{
    Querystring: { q?: string; status?: string };
  }>("/admin/extract", async (req, reply) => {
    const sql = getSql();
    const { q, status = "no_timeline" } = req.query;

    const sites = await sql.unsafe(`
        SELECT id, title_en, country, base_importance,
               timeline IS NOT NULL AS has_timeline,
               timeline_extracted_at,
               timeline_extraction_model
        FROM sites
        WHERE location IS NOT NULL
          ${q ? `AND title_en ILIKE '%${q.replace(/'/g, "''")}%'` : ""}
          ${status === "no_timeline" ? "AND timeline IS NULL" : ""}
          ${status === "has_timeline" ? "AND timeline IS NOT NULL" : ""}
        ORDER BY base_importance DESC, title_en
        LIMIT 200
      `);

    return reply.view("admin/extract/list", {
      title: "Extraction LLM — Admin",
      sites,
      status,
      q,
    });
  });

  // GET /admin/extract/:id — page extraction unitaire avec preview
  app.get<{ Params: { id: string } }>(
    "/admin/extract/:id",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site)
        return reply.status(404).view("errors/404", { title: "Not found" });

      const { Eta } = await import("eta");
      const nodePath = await import("path");
      const { fileURLToPath } = await import("url");
      const __dir = nodePath.dirname(fileURLToPath(import.meta.url));
      const viewsRoot = nodePath.join(__dir, "../../../views");
      const renderer = new Eta({ views: viewsRoot });
      const html = await renderer.renderAsync("admin/extract/preview", {
        title: `Extraction — ${site.title_en}`,
        site,
        viteDev: process.env.NODE_ENV !== "production",
      });
      return reply.type("text/html").send(html);
    },
  );

  // POST /admin/extract/:id/run — déclenche l'extraction LLM
  app.post<{ Params: { id: string } }>(
    "/admin/extract/:id/run",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site) return reply.status(404).send({ error: "Site not found" });

      try {
        const client = getClient();

        // Pipeline Wikipedia enrichi
        console.log(
          `[extract] ▶ ${site.title_en} (${site.wikidata_id}) country="${site.country ?? "unknown"}"`,
        );
        const t0 = Date.now();
        const wikiContext = await buildWikipediaContext(
          site.wikidata_id,
          site.country ?? "",
          site.title_en,
          client,
          ROUTER_MODEL,
        );

        if (!wikiContext.en && !wikiContext.local) {
          return reply
            .status(400)
            .send({ error: "Could not fetch Wikipedia content" });
        }
        if (!wikiContext.en) {
          console.warn(
            `[extract] ⚠ contenu EN vide pour ${site.title_en} — extraction basée uniquement sur la langue locale (${wikiContext.localLang})`,
          );
        }
        console.log(`[extract] ✓ Wikipedia en ${Date.now() - t0}ms`);

        const { polities: kp, cultures: kc } = await loadKnownEntities();
        const prompt = buildPrompt(site.title_en, wikiContext, kp, kc);
        console.log(
          `[extract] prompt: ${prompt.length} chars → appel ${MODEL}`,
        );
        const t1 = Date.now();
        const { raw, timeline } = await callClaude(prompt);
        console.log(
          `[extract] ✓ LLM en ${Date.now() - t1}ms — ${raw.length} chars retournés`,
        );

        return reply.send({
          site_id: site.id,
          title: site.title_en,
          timeline,
          raw,
          model: MODEL,
          router_model: ROUTER_MODEL,
          local_lang: wikiContext.localLang || null,
          extracted_at: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError)
          return reply
            .status(401)
            .send({ error: "ANTHROPIC_API_KEY invalide" });
        if (err instanceof Anthropic.RateLimitError)
          return reply.status(429).send({
            error: "Rate limit Anthropic — réessayer dans quelques secondes",
          });
        if (err instanceof Anthropic.APIError)
          return reply
            .status(502)
            .send({ error: `Anthropic API: ${(err as any).message}` });
        if (err instanceof SyntaxError)
          return reply
            .status(422)
            .send({ error: "Le modèle n'a pas retourné du JSON valide" });
        throw err;
      }
    },
  );

  // POST /admin/extract/:id/confirm — valide et écrit en base
  app.post<{
    Params: { id: string };
    Body: { timeline: SiteTimeline; model?: string; extracted_at?: string };
  }>("/admin/extract/:id/confirm", async (req, reply) => {
    const { timeline, model, extracted_at } = req.body;
    const { id } = req.params;

    if (!timeline)
      return reply.status(400).send({ error: "timeline required" });

    const sql = getSql();
    await sql`
      UPDATE sites SET
        timeline                  = ${sql.json(timeline)},
        timeline_extracted_at     = ${extracted_at ?? new Date().toISOString()},
        timeline_extraction_model = ${model ?? MODEL},
        last_updated              = now()
      WHERE id = ${id}
    `;

    const { polities, cultures } = await syncReferentialsFromTimeline(timeline);
    await updateTemporalBounds(sql, id, timeline);

    return reply.send({
      ok: true,
      polities_added: polities,
      cultures_added: cultures,
    });
  });

  // GET /admin/extract/stream?ids=... — SSE extraction batch
  app.get<{ Querystring: { ids: string } }>(
    "/admin/extract/stream",
    async (req, reply) => {
      const ids = req.query.ids?.split(",").filter(Boolean) ?? [];
      if (!ids.length) return reply.status(400).send({ error: "ids required" });

      try {
        getClient();
      } catch {
        return reply.status(500).send({ error: "ANTHROPIC_API_KEY not set" });
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders?.();

      const send = (event: string, data: object) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const client = getClient();
      const sql = getSql();
      let done = 0,
        errors = 0;

      send("start", { total: ids.length });

      for (const id of ids) {
        const site = (await getSiteById(id)) as any;
        if (!site) {
          errors++;
          send("error", { id, message: "Site introuvable" });
          continue;
        }

        send("processing", { id, title: site.title_en });

        try {
          console.log(
            `[extract:batch] ▶ ${site.title_en} (${site.wikidata_id})`,
          );
          const bt0 = Date.now();
          const wikiContext = await buildWikipediaContext(
            site.wikidata_id,
            site.country ?? "",
            site.title_en,
            client,
            ROUTER_MODEL,
          );

          if (!wikiContext.en && !wikiContext.local)
            throw new Error("Contenu Wikipedia introuvable");
          if (!wikiContext.en) {
            console.warn(
              `[extract:batch] ⚠ contenu EN vide — extraction basée uniquement sur ${wikiContext.localLang}`,
            );
          }
          console.log(
            `[extract:batch] ✓ Wikipedia en ${Date.now() - bt0}ms — local: ${wikiContext.localLang || "none"}`,
          );

          const { polities: kp, cultures: kc } = await loadKnownEntities();
          const prompt = buildPrompt(site.title_en, wikiContext, kp, kc);
          console.log(
            `[extract:batch] prompt: ${prompt.length} chars → appel ${MODEL}`,
          );
          const bt1 = Date.now();
          const { timeline } = await callClaude(prompt);
          console.log(`[extract:batch] ✓ LLM en ${Date.now() - bt1}ms`);

          await sql`
            UPDATE sites SET
              timeline                  = ${sql.json(timeline)},
              timeline_extracted_at     = now(),
              timeline_extraction_model = ${MODEL},
              last_updated              = now()
            WHERE id = ${id}
          `;

          await syncReferentialsFromTimeline(timeline);
          await updateTemporalBounds(sql, id, timeline);
          done++;
          send("done_one", {
            id,
            title: site.title_en,
            ok: true,
            local_lang: wikiContext.localLang || null,
          });
        } catch (err: any) {
          errors++;
          const msg =
            err instanceof Anthropic.RateLimitError
              ? "Rate limit — attente forcée"
              : err instanceof Anthropic.APIError
                ? `Anthropic: ${err.message}`
                : err.message;
          send("error", { id, title: site.title_en, message: msg });

          if (err instanceof Anthropic.RateLimitError) {
            await new Promise((r) => setTimeout(r, 10000));
            continue;
          }
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      send("done", { done, errors, total: ids.length });
      reply.raw.end();
    },
  );
};
