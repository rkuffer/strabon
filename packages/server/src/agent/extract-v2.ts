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
//
// THREE TRACK REGIMES (mirrors TRACK_META in @strabon/shared):
//   - step        : polity, culture, name, population — an entry is closed by the
//                   NEXT entry of the same track. `to` is meaningless here.
//   - occupation  : site_type — same, plus `to` = occupation hiatus.
//   - cooccurrent : religion, language — SEVERAL entries live at once. Nothing
//                   closes an entry implicitly except a later entry of the SAME
//                   entity, so `to` is REQUIRED to express disappearance.
// =============================================================================

import type { Sql } from "postgres";
import { hashText } from "./run-history.js";

// ── Country resolution ────────────────────────────────────────────────────────

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
  // Les bornes sont récupérées pour TOUS les kinds : elles sont exactement ce que
  // le garde déterministe vérifie après l'extraction. Juger le modèle sur un
  // critère qu'on ne lui montre jamais est injuste — et surtout inutile.
  const [religions, languages, polities, cultures] = await Promise.all([
    sql`SELECT qid, label_en, family_label, inception, dissolution
        FROM wikidata_entities WHERE kind = 'religion' ORDER BY label_en`,
    sql`SELECT qid, label_en, family_label, inception, dissolution
        FROM wikidata_entities WHERE kind = 'language' ORDER BY label_en`,
    sql`SELECT qid, label_en, description_en, inception, dissolution
        FROM wikidata_entities WHERE kind = 'polity' ORDER BY label_en`,
    sql`SELECT qid, label_en, description_en, inception, dissolution
        FROM wikidata_entities WHERE kind = 'culture' ORDER BY label_en`,
  ]);

  /**
   * L'espérance de vie de l'entité : "987→1791", "-250→", "→476".
   * Une droite ouverte = l'entité existe encore. Chaîne vide si Wikidata ne
   * connaît aucune des deux bornes — ce qui est le cas normal des religions et
   * des langues, et c'est correct : elles ne meurent pas à une date.
   */
  const formatLife = (
    inception: number | null,
    dissolution: number | null,
  ): string => {
    if (inception == null && dissolution == null) return "";
    return ` (${inception ?? "?"}→${dissolution ?? ""})`;
  };

  /**
   * Format : `QID | Label [family] (from→to) — description`
   *
   * Le séparateur compte. L'ancien format `QID = Label (description)` faisait
   * recopier la description DANS le nom : le modèle lisait
   * `Q656902 = Parisii (Gallic tribe)` et écrivait `"name": "Parisii (Gallic
   * tribe)"` — les parenthèses désambiguïsent un nom, partout ailleurs. Le tiret
   * cadratin sépare sans ambiguïté, et les parenthèses sont désormais réservées
   * à la seule espérance de vie.
   */
  const fmt = (rows: any[], withFamily: boolean = false) =>
    rows
      .map((r) => {
        const family =
          withFamily && r.family_label ? ` [${r.family_label}]` : "";
        const life = formatLife(r.inception, r.dissolution);
        const desc = r.description_en ? ` — ${r.description_en}` : "";
        return `  ${r.qid} | ${r.label_en}${family}${life}${desc}`;
      })
      .join("\n");

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

// ── Prompt builder ──────────────────

// Le template EST l'artefact archivé. Il porte ses trous — pas d'instanciation,
// donc pas de paramètre à neutraliser, donc rien à oublier quand on en ajoutera un.
export const EXTRACTION_PROMPT_TEMPLATE = `You are extracting structured historical timeline data from Wikipedia articles about an inhabited place or historical site.

Site: "{{title}}"

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
  "religion":   { "entries": [ { "from": number, "to"?: number, "value": { "name": string, "wikidata": string }, "role": string, ... } ] },
  "language":   { "entries": [ { "from": number, "to"?: number, "value": { "name": string, "wikidata": string }, "role": string, ... } ] },
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
  Types: destruction, fire, earthquake, flood, plague, siege, conquest, massacre, founding, refounding, abandonment, expulsion, depopulation, revolution, annexation, discovery

### Event types — never force a fit

The list above is CLOSED. If an event you consider notable matches NONE of these
types, **do not emit it at all**. Do not stretch the nearest type to accommodate it.

A mis-typed event is worse than a missing one: it enters the atlas as a fact of the
wrong kind, and it is invisible as an error. A political detention is not a
"conquest". A modern criminal shooting is not a "destruction". A religious massacre
is not an "expulsion" — it is a "massacre".

Use "massacre" for the deliberate killing of a substantial number of people at the
site (a pogrom, a sack with slaughter, a colonial or religious massacre, state
repression with mass killing). Use "expulsion" only when a population is DRIVEN OUT,
not killed.

Three types exist precisely because you were forcing them into "founding":
- "revolution": an uprising or revolutionary episode AT the site (the storming of the
  Bastille, a commune, a coup that happened here). It is not a "founding".
- "annexation": the site passes to another polity by treaty, cession or purchase,
  WITHOUT a siege or a battle. A "conquest" is taken by force; an annexation is not.
- "discovery": a site unknown to the modern world is found again (Lascaux in 1940,
  Machu Picchu in 1911). The discovery of a 17,000-year-old cave is NOT its
  "founding". The place was there all along; only our knowledge of it began.

If in doubt between two types, prefer the one the sources actually support; if none
support it, omit the event and, if it matters, mention it in the "notes" of the
relevant track entry instead.

Each track entry:
- "from": integer year (negative = BC)
- "to"?: integer year — OPTIONAL. Its meaning depends on the track. Read the
  section "The \`to\` field — three regimes" below BEFORE using it. Getting this
  wrong corrupts the timeline.
- "from_precision"?: 6=millennium 7=century 8=decade 9=year (default 9)
- "from_circa"?: boolean
- "confidence"?: "high" | "medium" | "low"
- "sources"?: short verbatim phrases from the text
- "notes"?: string
- "role"?: string — religion and language tracks ONLY

## The \`to\` field — three regimes. READ THIS CAREFULLY.

Tracks do NOT all behave the same way, because they do not all answer the same
kind of question. There are three regimes.

### Regime 1a — STEP tracks that CANNOT be closed: name, population
At any moment there is exactly ONE value, and each entry is closed by the NEXT
entry of the same track.
⇒ **NEVER set "to" on these two tracks.** It is meaningless and will be discarded.
A name is not *ended* — it is *replaced*. Same for a population figure.

### Regime 1b — STEP tracks that CAN be closed: polity, culture
Same step behaviour: one value at a time, and a new entry closes the previous one.
So in the ordinary case — one regime replaced by the next — you still emit NO "to".

BUT these two tracks have an ending, and only you can say when.

⇒ **Set "to" when the entity ends and NOTHING takes its place.**

This is not a nicety. Without it, your LAST entry runs to the end of the site's
occupation. And you have been instructed (see "The CULTURE track stops when
documented history begins") to STOP the culture track once real named regimes
appear — so your correct silence becomes a false assertion: the atlas states that
Merovingian culture prevails over France in 1990, because that was your last
entry and nothing closed it.

**Culture — the case that matters most.** When you stop the culture track, CLOSE
its last entry with a "to". The Merovingian culture of a French town does not run
to the present; it ends around 751, and after that the culture track is EMPTY.
An empty stretch is CORRECT and is displayed as such. An unclosed entry is a lie.

**Polity — narrower.** A site almost always has some polity, so the next entry
normally does the closing. Use "to" ONLY when there is a genuine gap: the polity
ceased to exist and you cannot name its successor for this site, or the site is
abandoned. Do not close a polity merely because the next one begins.

Never set "to" before "from", and never set a "to" that reaches or passes the
"from" of the next entry on the same track — that is not a closure, it is an
overlap.

### Regime 2 — OCCUPATION track: site_type
Same step behaviour, PLUS one special case: "to" marks an occupation HIATUS — the
site is abandoned/deserted at one date, THEN reoccupied later after a gap. See the
dedicated "Occupation hiatus" section below for the strict rules.

### Regime 3 — CO-OCCURRENT tracks: religion, language
Here SEVERAL entries are alive at the same time (Islam AND Christianity AND
Judaism, all at once, with different roles). This changes everything:

**A new entry does NOT close the previous one — it ADDS to it.**

So nothing can close an entry implicitly, EXCEPT a later entry of the SAME entity
(a role change: Christianity "minority" → Christianity "state"). Which means:

⇒ **When a religion or a language DISAPPEARS from the site, you MUST set "to" on
its last entry.** There is no other way to express it. If you omit it, the entity
is understood to still be present today — which is usually FALSE for ancient
religions and dead languages.

Concretely, in Paris:
- Roman religion is practiced from the 1st century, then dies out during
  christianisation. Its entry NEEDS a "to" (roughly late 4th–6th c.). Without it,
  the atlas states that Roman polytheism is still practiced in Paris today.
- Gaulish, then Latin, cease to be spoken. Their entries NEED a "to".
- Catholicism is still present today. Its entry takes NO "to".

### Rules for "to" on religion / language

- Set "to" when the entity CEASES to be present at the site: a religion dies out
  or is suppressed, a language ceases to be spoken, a community is expelled.
- **A role change is NOT a disappearance.** Christianity going from "minority" to
  "state" is a NEW ENTRY of Christianity, not a "to" followed by a new one. Do not
  close an entity that is still there.
- **Another entity becoming dominant does NOT close this one.** Christianity
  becoming the state religion does not delete paganism overnight — paganism keeps
  running (with a lower role, if you can say so) until it actually dies out. That
  is the whole point of a co-occurrent track. Do not close an entity just because
  a rival rose.
- **An entity that still exists today takes NO "to".** Catholicism in Paris, French
  in Paris: no "to".
- **An entity can disappear and COME BACK.** That is legitimate and expressive:
  emit the first entry with a "to", then a NEW entry at the date of return. E.g.
  Judaism in Paris: present in the Middle Ages, expelled in 1394, returning at the
  end of the 18th century ⇒ two entries with a real gap between them.
- Disappearance is usually GRADUAL and poorly dated. Give the best-supported date,
  set "confidence": "low"/"medium", and say so in "notes" (e.g. "gradual decline
  through the 5th–6th c.; date approximate"). An approximate, honestly-flagged "to"
  is far better than no "to" at all.
- Never set "to" before "from", and never set "to" on an entry that a later entry
  of the SAME entity already supersedes.

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

## Deep prehistory — the SITE, not the region

**THE RULE: if the remains are NEARBY but not AT the site, the entry does not exist.
Do not extract it.**

Not with a note. Not with low confidence. Not at all.

### The test — apply it to EVERY EARLY ENTRY, ON EVERY TRACK

This is not a rule about site_type. It governs **every track**: site_type, polity,
culture, religion, language, name, population. For each entry before 5000 BC, answer
this question literally:

> "Does the source state that THIS EXACT LOCATION — this hill, this cave, this river
> mouth, this urban core — was occupied at that date?"

If you cannot answer YES, **the entry does not exist, on ANY track**. Delete it.

"Archaeological sites in the area", "caves in the region", "the surrounding district",
"nearby rock shelters", "the site is near the city", "this part of the country" — none
of these answer YES. They are the history of OTHER sites, which have their own entries
in this atlas. Attributing them here is a falsification: it invents a 60,000-year
antiquity for a place that does not have one.

### The culture track is the usual leak

You may correctly refrain from putting a Palaeolithic occupation on site_type, and then
put the very same Palaeolithic ARCHAEOLOGICAL CULTURE on the culture track anyway. That
is the same error, one column to the right, and it is just as false.

An archaeological culture attested at a rock shelter 30 km away is the culture OF THAT
SHELTER. A city founded in 1820 has no Palaeolithic culture. If the site was not
inhabited at that date, it had NO culture, NO polity, NO religion and NO language at
that date — because there was nobody there.

Concretely: if a named prehistoric culture (a Howiesons Poort, a Mousterian, an
Aurignacian…) comes from finds in the region and not from the site's own strata, it does
not belong in this timeline. Whatever the track.

### A note does NOT redeem a wrong entry

This is the trap. You will be tempted to extract the entry anyway and disclose the
problem in "notes". That is not honesty — it is a false entry with a footnote. The entry
is what enters the database and appears on the map; the note is not.

If you find yourself writing anything like:
  - "these are nearby cave/rock shelter sites, not the urban core"
  - "the site itself is near the city area"
  - "found in caves surrounding the city"
  - "treated as regional occupation"
  - "inferred from finds in the surrounding area"
…you have just PROVEN the entry must not exist. **Delete it.** The very fact that you
needed to write that sentence is the answer.

### The scope, so this is not misunderstood

This atlas covers inhabited places **from the Palaeolithic to the present**. There is NO
lower date limit. A genuinely Palaeolithic site — an occupied cave, a rock shelter, a
repeatedly-used camp — is fully in scope, with its cultures, and must be extracted with
the same care as a Bronze Age city. When deep occupation IS attested AT the site itself
(a tell with Neolithic strata, a cave with continuous occupation layers, a settlement
mound), extract it in full, as early as the evidence goes. That is the whole point of
the atlas.

The rule above removes what belongs to OTHER places. It does not truncate what belongs
to THIS one.

If the source is genuinely ambiguous about whether the finds are AT the site or merely
near it, prefer the LATER, safer start date, mark "confidence": "low", and say so in
"notes". A start date that is too cautious is a small loss. An invented antiquity is a
corruption of the atlas.

## Never substitute a related entity for the one you mean

If the entity you need has no QID you are sure of, the answer is ALWAYS: keep the correct NAME, omit the "wikidata" field, and signal it in "missing_entities".

It is NEVER: replace the entity with a similar one that does have a QID.

Writing "Zulu" because the language is Xhosa and Xhosa is not in the referential is not a compromise — it is a FALSIFICATION. You have changed the FACT, not merely the identifier.
The atlas will then state that Zulu was spoken at a place where it was not. The same goes for a neighbouring polity, a cousin culture, a related religion.

The name is the fact. The QID is only its address. Never corrupt the fact to obtain an address.

**The referential being the only authorised QID source does NOT mean you must find something in it.** If the entity you need is not there, the referential simply does not cover it — that is a fact about the referential, not an instruction to pick its nearest neighbour.

Watch for this exact reasoning in yourself: "X is in the referential but is not precisely the same as Y." If you can write that sentence, you have PROVEN X is the wrong entity. Gaulish is not Common Brythonic. Zulu is not Xhosa. Cantonese is not Puxian Min. A neighbouring language is a DIFFERENT language.

The correct output is always the same three moves:
  1. Write the TRUE name in the track ("Common Brythonic").
  2. Omit "wikidata" entirely.
  3. Signal the TRUE name in "missing_entities" — never the substitute.

And never signal an entity that IS in the referential. A gap on "Gaulish" when Gaulish has a QID is meaningless: it asks us to add something we already have, while the entity actually missing — Common Brythonic — goes unrecorded.

Two different substitutions, both forbidden:

**A SIBLING is not the entity.** Gaulish is not Common Brythonic; Zulu is not Xhosa; Cantonese is not Puxian Min. These are distinct entities at the same level. Using one for the other is simply FALSE — the atlas will state that a language was spoken where it was not.

**A PARENT is not the entity either.** "Germanic peoples" for Anglo-Saxon culture, "Chinese civilization" for a specific dynasty's culture, "Islam" when you know it was Sunni. This one is not false — Anglo-Saxons ARE Germanic — which is exactly why it is tempting, and why it is worse: it looks defensible. But it is USELESS. A hull covering "Germanic peoples" would span London, Scandinavia and the Rhineland at once, and say nothing. Precision is the point of the track.

(The exception, already stated above: staying at the generic level is CORRECT when you genuinely do not know the specific one. "Islam" is right when the sources do not say which branch. The error is knowing the precise entity and writing the vague one anyway because only the vague one has a QID.)

## Religion and Language tracks — co-occurrence with roles

These two tracks support CO-OCCURRENCE: multiple entries can overlap temporally.
For any given period, list the 4-5 most significant religions/languages, each with a ROLE qualifier.

### Role qualifiers (required on every religion and language entry):
- "state": official/state religion or language (legally established or de facto official) 
  **"state" is EXCLUSIVE: at most ONE entity can hold it at any given moment.** A state has one official religion, not two. If a new religion becomes the state religion, the previous one must STOP being "state" at that date — either it ends entirely (a "to"), or it continues with a lower role (a NEW entry at the transition date, with "major", "minor" or "minority").
  Concretely: if Roman religion is "state" from -60 and Christianity becomes "state" in 300, then Roman religion CANNOT still be "state" between 300 and 400. Give it a new entry at 300 with a reduced role, then close it with a "to" when it dies out. Overlapping "state" entries are always an error.
  The same holds for language: one official language at a time (a genuinely co-official pair — e.g. two languages of a bilingual state — is the rare exception, and must be stated by the sources, not assumed).
- "major": widely practiced/spoken by a large portion of the population
- "minor": present and notable but not dominant
- "minority": small but historically significant community

### Rules for religion/language:
- Maximum 4-5 entries per track per period. Focus on what is historically significant.
- Entries overlap: if Islam (state) and Christianity (minority) coexist, both appear, each with its own "from".
- When the religious/linguistic landscape CHANGES (a conquest introduces a new state religion, an emancipation shifts a role), emit new entries for the changed roles. Entries that continue unchanged need not be repeated.
- Role changes matter: a religion moving from "state" to "major" (e.g. after secularisation) or from "minor" to "state" (e.g. after a conversion of rulers) warrants a NEW ENTRY of that same entity at the transition date. Do NOT use "to" for this.
- Use ONLY the QIDs from the referential lists below for religion and language. If the religion/language is NOT in the list, DO NOT invent a QID — add it to "missing_entities" and include the timeline entry with "name" only.
- **Close what dies.** Before you finish, re-read your religion and language tracks and ask, for EACH entity: "is it still present at this site today?" If the answer is no, its last entry MUST carry a "to". This is the single most commonly forgotten field.

### Precision level: when you name a BRANCH, close the TRUNK

A religion or language may be known at different levels of precision depending on the period, and that is normal. "Islam" is the honest answer when the sources do not say which branch dominated; "Shia Islam" is the honest answer when they do.

But the two must not run in parallel. Once you name the branch, the generic parent has been SUPERSEDED — not joined.

**Rule: when a more precise entity takes over from a broader one, close the broader one with a "to" at that exact date.**

Concretely:
  - Islam "major" from 643, then Shia Islam "major" from 900 and Sunni Islam "minor" from 900 ⇒ the "Islam" entry MUST carry "to": 900. It says "from 643 to 900 we know only that the site was Muslim; after 900 we can say which branches."
  - Christianity "minor" from 250, then Catholic Church "state" from 400 ⇒ Christianity MUST carry "to": 400.

Without the "to", the atlas shows Islam AND Shia Islam AND Sunni Islam as three
co-existing religions at the same site in 1500 — which is not a fact about the world, it is an artefact of your having described the same reality twice at two levels of detail.

Co-occurrence is for religions that GENUINELY COEXIST — Islam and Christianity and Judaism in one city. It is NOT for a religion and its own sub-branch. A branch does not coexist with its trunk; it IS the trunk, described more precisely.

Two things this rule does NOT mean:
  - It does not mean you should always reach for the branch. If the sources do not say which branch, stay generic and leave the entry open. Vagueness is honest; invented precision is not.
  - It does not mean two branches cannot coexist. Shia and Sunni side by side, Catholic and Protestant side by side — that is real co-occurrence, and both stay open.

The same applies to language: if you record "Chinese" and then "Puxian Min", or "Kurdish" and then "Sorani Kurdish", close the broader one when the narrower one begins. Do not stack a language on top of its own dialect.

## Naming an entity from the referential — READ THIS, IT IS SHORT AND IT MATTERS

The referential lists below are formatted:

  QID | Label — description

**When you take a QID from the referential, write its "name" EXACTLY as the
referential's Label gives it. Character for character.**

- The NAME is the Label — the text between the "|" and the "—".
- What follows the "—" is a DESCRIPTION. It is there to help you choose the right
  entity. It is NEVER part of the name.

So \`Q656902 | Parisii — Gallic tribe\` gives \`"name": "Parisii"\`.
NOT "Parisii (Gallic tribe)". NOT "Parisii (Gaul)". Just "Parisii".

And do not RENAME an entity you have matched. If you use \`Q146246 | Francia\`,
the name is "Francia" — not "Kingdom of the Franks", even if that is the phrase
the article uses and even though they denote the same thing. Say it in "notes" if
you like; the "name" field belongs to the referential.

The reason is mechanical, not aesthetic: a deterministic check compares your name
against the referential's label for that QID. If they disagree, it concludes you
have attached the wrong QID to the entity — and it STRIPS THE QID. You lose a
correct identification by renaming a correct match.

(This applies only to entities you take FROM the referential. For an entity that
is NOT there, the name is yours to write — and it must be the TRUE name, see
"Never substitute a related entity" below.)

### The (from→to) is the entity's LIFETIME. It is checked.

Referential entries may carry the entity's own lifetime in parentheses:

  Q70972  | Kingdom of France (987→1791)
  Q207162 | Bourbon Restoration in France (1815→1830)
  Q142    | France (1958→)

An open right side means the entity still exists today.

**An entry whose "from" falls outside its entity's lifetime is an ERROR, and it is
detected deterministically after you finish.** You cannot place a site under the
Kingdom of France in 1814: that state ended in 1791. Check every polity and culture
"from" against the parentheses before you emit it.

This is also the fastest way to apply the granularity rule above. If your period sits
outside the entity's lifetime, the entity is the wrong one — and the right one is
usually a few lines away in the same list, with a lifetime that fits.

Two things this does NOT authorise:
- The lifetimes come from Wikidata and are sometimes wrong or over-precise. If the
  sources clearly attest an entity at a date its lifetime excludes, trust the sources,
  keep the entry, and say so in "notes". The check will flag it for a human — which is
  exactly what should happen.
- An absent lifetime means Wikidata does not record one. It does NOT mean the entity
  is eternal. Religions and languages rarely carry one, and that is correct: they do
  not die on a date.

### RELIGION referential — use ONLY these QIDs:
{{religions}}

### LANGUAGE referential — use ONLY these QIDs:
{{languages}}

## Wikidata QID rules — CRITICAL

The "wikidata" field for polity and culture entries MUST be the QID of the ENTITY ITSELF.

### POLITY QIDs — use these exact QIDs when applicable:
{{polities}}

If the polity is not in this list, look up its actual Wikidata QID from your knowledge and use it.
If you cannot find a Wikidata QID, omit the "wikidata" field entirely (the entry will still appear in the timeline).
NEVER invent a QID. NEVER use a "local_" identifier.
NEVER use the QID of a city, a region, or a person as a polity QID.

### CULTURE QIDs — use these exact QIDs when applicable:
{{cultures}}

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
- And NEVER swap the entity itself to obtain a QID — see "Never substitute a related
  entity" above. Omitting a QID is honest; renaming the entity is falsification.

## Granularity — name the regime, not its container

This is the single most frequent error measured across this atlas, and it is not
hallucination: it is an UNSTABLE GRANULARITY POLICY. On the best-documented sites
you name the precise regime; on thinner ones you fall back on its container. Same
prompt, same fact, two different answers.

**THE RULE: name the most precise entity the sources attest, never its aggregate.**

The measured case, on twenty-two French towns: the polity for 1814–1830 was written
as "Kingdom of France" (Q70972). But the Kingdom of France ENDED in 1791. The regime
of 1814 is the **Bourbon Restoration** (Q207162), and 1830–1848 is the **July
Monarchy** (Q58202) — both are distinct entities with their own QIDs, and both are in
the referential. On Paris and Bordeaux you used them correctly. On the twenty others
you did not.

### The test — apply it to EVERY polity and culture entry

Look at the entry you are about to write, and at the period it is meant to cover.

> **"Does this entity's own lifetime extend far beyond the period I am describing?"**

If YES, you are almost certainly naming a container instead of its content. Ask
whether a distinct entity exists FOR THIS PERIOD. It usually does, and it usually
has a QID.

  - 1814 in France → not "Kingdom of France" (987–1791), but "Bourbon Restoration".
  - 1852 in France → not "France", but "Second French Empire".
  - 1940 in France → not "France", but "Vichy France" or "Nazi Germany" as applicable.
  - A Chinese city in 1200 → not "China", but the Song, or the Jin, or the Xia.
  - A German town in 1750 → not "Germany" (which did not exist), but its actual
    principality, or the Holy Roman Empire.

### Where the line is

This is NOT an instruction to invent precision. Two guards:

- If the sources do not tell you which regime held the site, and you cannot infer it
  safely, **leave the gap empty**. An honest hole beats a container. Everything in
  "Track continuity and structural inference" still applies.
- Do not descend below the level of a POLITY. A dynasty is not a state, a ruler is
  not a regime, a province is not a polity. Precision means the right ENTITY, not the
  smallest one.

### A country's QID is the sharpest trap

\`France = Q142\` denotes the polity France — the Fifth Republic and its continuity,
from 1958. It is NOT a label you may hang over two thousand years of French history.
The same holds for every modern country QID. If you find yourself using a modern
country's QID for anything before the twentieth century, stop: you have named a
container.

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
{{filiation}}

## Rules

1. Each track entry signals a CHANGE for that dimension only. Other tracks are independent.
2. Only extract what is explicitly stated or strongly implied. Do not invent dates or entities.
3. Sort each track's entries by "from" ascending.
4. CRITICAL: Each track MUST be an object with an "entries" array. Do NOT use bare arrays. Do NOT use a "tracks" wrapper.
5. Return ONLY valid JSON — no prose, no markdown fences, no comments.
6. **BC years are NEGATIVE.** Before writing any year, ask whether it is BC. The
   Achaemenid Empire begins at -550, NOT 550. Alexander dies at -323. A dropped minus
   sign silently moves an entity by a millennium and reorders the whole timeline. After
   drafting each track, re-read every year of every entry earlier than the common era
   and confirm the sign.

## Occupation hiatus — the "to" field on the site_type track

On site_type, "to" has ONE meaning and one only: an explicitly attested occupation
HIATUS. The site is abandoned/deserted at one date, THEN reoccupied later after a
gap. Model it as:
  - the site_type entry covering the occupation, with "to" = year occupation ends
  - a NEW site_type entry with "from" = year of reoccupation
The interval between "to" and the next "from" is a gap during which the site is
considered UNOCCUPIED — it disappears from the map and stops contributing to its
polity's and culture's spatial extent.

Hard rules for "to" on site_type:
- By DEFAULT, do NOT set it. A normal transition — a change of type — is modelled by
  letting the next entry close the previous one. Setting "to" on an ordinary
  transition is WRONG and breaks the timeline.
- A hiatus means the site was UNOCCUPIED / DESERTED / EMPTY for a period — NOT
  merely "sparsely populated", "declined", "reduced" or "in decline". A thinly
  populated site is still occupied: do NOT use "to" for it.
- NEVER set "to" equal to (or greater than) the next entry's "from". If the next
  period begins immediately — i.e. occupation is continuous even though its
  character changes — OMIT "to" entirely. "to" is valid ONLY when it is strictly
  BEFORE the next "from", leaving a real unoccupied gap.
- Emit "to" ONLY if a later reoccupation entry exists. A site abandoned and never
  reoccupied has NO "to" — that is a dissolution, expressed by a final
  "abandoned"/"ruins" entry or an abandonment event, not by "to".
- NEVER emit "to" for mere uncertainty of attestation. "occupied/attested until X"
  with no mention of abandonment ⇒ NO "to".
- When you set "to", add a "notes" field citing the source for BOTH the
  abandonment and the reoccupation.

Example — a tell occupied, destroyed and deserted, then reoccupied centuries later:
  "site_type": { "entries": [
    { "from": -3000, "value": "city", "to": -1600,
      "confidence": "medium",
      "notes": "Destroyed and abandoned c. 1600 BC (source: ...)." },
    { "from": -900, "value": "town",
      "confidence": "medium",
      "notes": "Reoccupied in the Neo-Assyrian period (source: ...)." }
  ] }

Remember: this hiatus meaning of "to" is SPECIFIC to site_type. On religion and
language, "to" means something else entirely (the entity's disappearance) — see
"The \`to\` field — three regimes" above.

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

### THE GENERAL RULE: an entity cannot begin before it existed

Before writing any "from", ask: **did this entity exist at that date?**

Not "does it govern/prevail there today", not "is it the natural label for this place" —
did it EXIST, as such, in that year? If not, the "from" is wrong. Move it to the entity's
actual date of appearance, or drop the entry.

This sounds obvious and is the single most common anachronism. Examples of the error:
  - Standard Chinese (Putonghua) as the state language of a 6th-century county. It did
    not exist. Its "from" is 1949, not 568.
  - The People's Republic of China as the polity of a Ming-era city.
  - Islam anywhere before 610 AD.
  - "Modern French culture" in the 12th century.
  - A modern nation-state QID used for a medieval kingdom.

And a specific trap: **there is no such thing as "retroactive" attribution.** If you
catch yourself writing "retroactively applied", "projected back", "used here to
represent the modern period", or any equivalent — you are writing an anachronism and you
know it. The track is a chronology, not a label. Give the entity its true start date, or
omit it.

The corollary also holds: an entity cannot continue after it ceased to exist. The Roman
Empire is not the polity of a 9th-century town.

### Correcting the source

Wikipedia is your primary source, but it can contain errors, oversimplifications, or
anachronisms. After extracting from the text, validate each entry against your historical
and archaeological knowledge. Apply the following corrections when the evidence is
unambiguous, and record your reasoning in the "notes" field.

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

1. For a site that is STILL INHABITED today, the "polity" track must not stop at some medieval or early-modern entry and then implicitly run unchanged to the present. A living site always has a governing polity up to today. Continue track forward to the present using the well-established political history of its country/region — e.g. a French town's polity continues Kingdom of France → the Revolutionary and Napoleonic states → modern France. The same applies to site_type: bring it to the site's current status.

2. You MAY infer this forward (and backward) continuity from the general history of the region even when the article does not state it for THIS specific site.

### The CULTURE track stops when documented history begins

The culture track holds ARCHAEOLOGICAL CULTURES and NAMED HISTORICAL CIVILISATIONS — Halaf, Yamnaya, Gauls, Ancient Rome, Merovingian, Ancient Egypt. It does NOT hold modern national or colonial cultures.

**Never emit entries like:** "modern French culture", "South African culture", "British colonial culture", "Post-apartheid South African culture", "Early modern French culture", "medieval French culture", "Chinese civilization" (as a catch-all for two millennia). These are not entities. They are the name of a country with the word "culture" attached, and they say nothing the polity, language and religion tracks do not already say better.

The rule: once a site enters the documented history of an identifiable state — once the polity track carries real, named regimes — the culture track has done its work and should **stop**. Its purpose is to describe peoples we know through their material remains, not to relabel modern nations.

So: unlike polity, culture must NOT be continued forward to the present. An empty culture track for the modern period is CORRECT. A French town's culture track may legitimately end with "Merovingian" and say nothing after — France's polity, French the language, and Catholicism the religion carry the rest.

**And when you stop, CLOSE THE LAST ENTRY WITH A "to".** See "Regime 1b" above. This
is the other half of the rule and it is not optional: an unclosed last entry does not
stop — it runs to the end of the site's occupation. Stopping in silence is what puts
Merovingian culture over France in 1990. Merovingian ends around 751. Say so.

### THE HARD LIMIT: inference BRIDGES between anchors. It never fills a VOID.

This is the boundary, and it is the one most often crossed. Read it twice.

Structural inference is legitimate ONLY to bridge a gap BETWEEN TWO ATTESTED POINTS — the site is documented before, and documented after, so it obviously existed in between, and we may say which state governed it. Paris is attested in 1436 and in 1789; inferring that it remained French in 1600 is sound.

Structural inference is FORBIDDEN when the site itself is absent from the record. If the sources say nothing about the place for a long stretch — no mention, no ruins, no continuity of occupation — then **you do not know whether anybody lived there at all**.
Deriving its polity, culture, religion and language from the general history of the country is not inference: it is FABRICATION. You would be asserting that a place existed, and was ruled, when the only honest statement is that we have no idea.

**The decisive question is not "who ruled this region then?" — it is "was this place inhabited then, and do the sources show it?"**

Worked example of the error. A town whose sources attest Chalcolithic artefacts (4400 BC) and then nothing at all until a 14th-century principality. The tempting move is to fill the 5,700-year gap with the standard sequence: Achaemenid → Seleucid → Parthian → Sasanian → Umayyad → Abbasid, each marked "not attested specifically for this site". **Do not do this.** Those notes are your own admission that you are inventing. Nothing tells you the place was even occupied under the Sasanians. The evidential silence IS the finding — leave the gap empty and let the timeline show it.

If you catch yourself writing "inferred from regional control", "not attested
specifically for this site", "based on the general history of the region" on a series of entries with no attested anchor after them — delete the whole series.

### The scope of inference, restated precisely

- It applies ONLY to the structural continuity of the **polity**, **culture**,
  **religion** and **language** tracks, BETWEEN attested anchors, or FORWARD to the present from the last attested anchor for a site that is demonstrably still inhabited.
- Every inferred entry MUST be marked "confidence": "low" (or "medium" at best, when the regional framework is very firm) and carry a "notes" field saying it is inferred from regional context.
- It must NOT be used to invent any site-SPECIFIC detail: never infer a founding date, a population figure, an event, a minority community, or a precise name from general knowledge. Those remain strictly attestation-governed.
- It does NOT override the "Epistemological caution for ancient polities" above: do not infer ancient or contested polities (pre-800 BC, religiously-derived, etc.).
- If the region/period is itself poorly understood, so that even general knowledge cannot give a reliable framework, do NOT fabricate a trame: leave the track at its last attested entry and note the uncertainty. Honest gaps beat invented continuity.

The religion and language tracks may use the same bridging inference, with the same limits: the dominant religion/language of a well-documented region and period may be attributed to a site of that region (e.g. a 12th-century French town: Catholic Church "state", Old French "major"), marked "confidence": "low"/"medium" with a note. But NEVER infer minority communities: the presence of a specific minority at a specific site (a Jewish community, an Armenian quarter...) is site-specific DETAIL requiring attestation.

Structural inference also covers DISAPPEARANCE. The extinction of Roman religion, of Gaulish, of Latin as a spoken vernacular are well-established regional facts: you may close those entries with an approximate "to" and a low-confidence note, even if the article says nothing about this specific site. Leaving a dead religion running to the present day is a worse error than an approximate closing date.

Rule of thumb: infer the STRUCTURE between what is known. Never infer the EXISTENCE of what is unknown.

## No placeholder entities — an absence is not an entity

If you do not know the polity, the culture, the religion or the language, **emit no
entry**. Do not invent a descriptive stand-in.

These are NOT entities, and must never appear in a "name" field:
  - "unknown prehistoric language"
  - "prehistoric settlement (Iranian Plateau)"
  - "Chalcolithic culture of the Iranian Plateau"
  - "the local tribe", "indigenous population", "pre-Roman inhabitants"
  - any phrase containing "unknown", "unnamed", "unidentified", "no specific X"

They are descriptions of OUR IGNORANCE dressed up as historical facts. Written into a
track, they become a coloured band on the map and a candidate for the shared referential
— an absence promoted to an entity.

The correct handling of ignorance is the EMPTY TRACK. A timeline whose culture track
starts in 1380 says truthfully: "before that, we don't know." A timeline that says
"Chalcolithic culture of the Iranian Plateau" says something false, because no such
named culture is being claimed by any source.

Exception: a genuinely named, source-attested archaeological culture (Howiesons Poort,
Halaf, Yamnaya, Linear Pottery) is a real entity — use it, if it is attested AT THE SITE.
The test is whether the source names it, not whether you can construct a plausible label
for the period.

### CRITICAL — do not over-correct: the tracks are INDEPENDENT

Dropping a placeholder CULTURE must NEVER make you drop the attested OCCUPATION.

These are two different tracks answering two different questions:
  - site_type: **was this place inhabited, and as what?**
  - culture:   **which NAMED culture did its inhabitants belong to?**

You can know the first and not the second. In deep prehistory that is the NORMAL case,
and it is expressed as: **site_type FILLED, culture EMPTY.**

Worked example. A town whose sources report artefacts found AT the site, dated 4400–4100
BC, described as one of the earliest settlements of the region. Correct output:
  - site_type: an entry at -4400, "settlement", "confidence": "medium", with the source.
    This occupation is ATTESTED AT THE SITE and is one of the most valuable facts in the
    entire timeline. **KEEP IT.**
  - culture: NO entry — no source names a culture. Not "Chalcolithic culture of the
    plateau". Nothing at all.
  - polity, religion, language: NO entries. We know people were there; we know nothing
    else about them.

Deleting the -4400 occupation because you could not name its culture would destroy the
site's deepest attested fact in order to tidy up a DIFFERENT track. Never do that. Rule 1
holds: each track is independent.

## A historical PERIOD is not a POLITY

The polity track holds the entity that GOVERNED the site — an empire, a kingdom, a
republic, a caliphate, a city-state, a principality. It does not hold the name of an era.

These are periods, not polities, and must NEVER appear on the polity track:
  - "Five Dynasties and Ten Kingdoms Period", "Warring States period", "Spring and Autumn"
  - "Hellenistic period", "Late Antiquity", "the Middle Ages"
  - "Bronze Age", "Iron Age", "Chalcolithic"
  - "the Interregnum", "the Time of Troubles", "the colonial period"

A period is a slice of time. It governs nobody. Writing it on the polity track is a
category error that puts an era where a state should be.

**When a period covers a fragmented era, name the REGIME THAT ACTUALLY HELD THE SITE.**
That is the useful fact, and it is usually available. During the Five Dynasties and Ten
Kingdoms era, the region around Fuzhou and Putian was ruled by the **Min Kingdom** (闽) —
that is the polity, not the era. During the Warring States, a site belonged to Qi, or Chu,
or Qin — name it.

If you genuinely do not know which regime held the site during a fragmented period, leave
the track EMPTY for that stretch. An honest gap is correct; an era-as-polity is false.

The same applies to the culture track: an ARCHAEOLOGICAL culture (Halaf, Yamnaya) is an
entity; a chronological period (Bronze Age, Neolithic) is not. If all you can say is
"Bronze Age", you have named a date range, not a culture — say nothing.

## Population — sampling and historical depth

**A population figure counts PEOPLE. Nothing else.**

Never convert, and never substitute, another unit: houses, dwellings, hearths, households, families, taxpayers, adult males, communicants, registered voters. If the source says "the town contained four houses", the population is NOT 4. It is unknown — omit the entry.

**Never invent a multiplier.** "12 families × ~5 persons = 60" is a fabricated number dressed as a source. The source said twelve families; it did not say sixty people. If the source itself supplies the household size, you may use it and must say so in "notes" with "confidence": "low". Otherwise: OMIT.

And if you find yourself writing a note like "omitting this entry would be safer, but…" — **that IS the answer. Omit it.** The hesitation you just wrote down is the finding.
There is no version of this where the invented number survives because you flagged it.

An entry of "4 inhabitants" or "60 inhabitants" for a founded town is not a small error; it is a nonsense that will be plotted as a data point on a demographic curve, indefinitely.

The population track shows a broad demographic trajectory on a deep-time atlas; it is NOT for reproducing census tables. Apply deliberate sampling:

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

**A population figure must come from the SOURCES. Never from your own knowledge.**

Population is site-specific DETAIL. The structural-inference exception does NOT apply to it — not ever. "A typical Roman provincial city held about 20,000 people" is a fact about Roman cities in general; it is NOT a fact about THIS city, and writing it as one is fabrication.

If you catch yourself writing "not from the article", "standard historical estimate", "rough estimate for a city of this type", "typical for the period" — **that is the answer. Omit the entry.** Those phrases are your own admission that the number is not a finding about this place.

An empty population track is a correct and honest output. An invented figure is a data point on a demographic curve, forever, and nothing distinguishes it from a real one.

## When the sources say nothing, the timeline is EMPTY

A site can be perfectly valid — a real inhabited place, correctly identified — and
still have an article that contains NO history. References, external links,
coordinates, a category. Nothing else.

**A valid site is not a source.** That the place deserves a timeline does not mean
you have the material to write one. These are two entirely different statements, and
you have confused them before.

The measured case: a settlement in the Bahamas whose article yielded 162 characters —
two sections, "References" and "External links". You wrote, correctly:

> "the pre-filtered historical sections contain essentially no historical content"
> "I must be very careful not to fabricate site-specific details"

…and then produced a complete timeline: a founding date, a colonial polity, a state
religion, a language — every single entry carrying, in its own "notes", the confession
that it came from regional context and not from the site. Six entries, six admissions.

### The test

If you find yourself writing, in a "notes" field, any of:
  - "inferred from regional context only"
  - "no specific information is given in the article for this site"
  - "not attested in the article"
  - "the [country] were colonized by…, so this site presumably…"
  - "[X] is the dominant religion/language of [country]"

…on an entry that has NO attested anchor at this site, **you have just proven the
entry must not exist. Delete it.** The sentence you needed to write is the answer.

The correct output for a site with no historical content is a timeline that is nearly
empty — perhaps a single site_type entry, perhaps nothing at all. That is not a
failure. It is the truth, and it is far more valuable than a plausible fiction: the
empty timeline can be curated later; the fiction is indistinguishable from a fact.

## Uninhabited sites — a monument has no polity, no language, no religion

Some sites in this atlas are not inhabited places. They are caves, tombs, sanctuaries,
ruins, megaliths — places built or used by people who are long gone, and where nobody
lives.

For such a site, the tracks that describe a LIVING COMMUNITY have no referent:

  - **polity, language, religion** describe the people who live at the site. If nobody
    lives there, these tracks describe NOBODY. Leave them EMPTY for the period of
    abandonment, and do NOT resume them for the modern era.
  - **culture** remains valid — it is the culture of those who made the place
    (Magdalenian, for a decorated Palaeolithic cave). Give it a "to" when their
    occupation ends.
  - **site_type** remains valid throughout, including "abandoned" or "ruins".

The measured case: Lascaux. The cave was occupied around 17,000 BC and abandoned;
it was found again in 1940 and is a heritage site. The correct polity track is EMPTY.
The correct language track is EMPTY. Writing "polity: France, from 1940" and
"language: French, major, from 1940" describes the country in which the hole in the
ground is located. **Nobody speaks French at Lascaux. Nobody lives at Lascaux.**

The test: **is there a community living at this site, whose polity / language /
religion these entries describe?** If not, the entries do not exist.

(The modern administrative tutelage of a monument — its state, its heritage listing —
is not a fact about the site's inhabitants. It belongs in "notes", if anywhere.)

## Names — a name has a birth date

A name entry's "from" is the date THE NAME came into use — not the date the PLACE
came into existence. These are different, and confusing them retro-projects a modern
word onto a prehistoric people.

The measured case: Lascaux again. The cave was painted around 17,000 BC. The name
"Lascaux" is an Occitan place-name, attested from the early 14th century, and your own
notes said so — and you still wrote it as a French-language name entry with
"from": -17000. The Magdalenians did not call it Lascaux. They did not speak French.

So:
- A modern or medieval toponym takes the "from" of ITS OWN attestation, not the site's.
- If you do not know when a name appeared, use the earliest date it is attested and
  set "confidence" accordingly. Do not reach back to the site's origin.
- A site can perfectly well have NO known name for its earliest periods. That is normal
  and correct: an empty stretch at the start of the name track.
- The "lang" field must be the language of the NAME, not the language of the country.
  "Lutetia" is Latin. "Lutèce" is French. They are two entries.

## Wikipedia sources

{{two_sources_note}}

### English article (pre-filtered to historical sections)
---
{{context_en}}
---
{{local_section}}

Return ONLY valid JSON — no prose, no markdown fences.`;

export const EXTRACTION_PROMPT_HASH = hashText(EXTRACTION_PROMPT_TEMPLATE);

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
  const twoSources = context.local
    ? `Two sources are provided: the English article (primary) and a local language article (${context.localLang}, supplementary). Prefer the English source for dates and political entities; use the local source primarily for vernacular names and any additional historical details it provides.`
    : "";

  const out = EXTRACTION_PROMPT_TEMPLATE.replaceAll("{{title}}", title)
    .replaceAll("{{religions}}", refs.religions)
    .replaceAll("{{languages}}", refs.languages)
    .replaceAll("{{polities}}", refs.polities)
    .replaceAll("{{cultures}}", refs.cultures)
    .replaceAll("{{filiation}}", filiation)
    .replaceAll("{{two_sources_note}}", twoSources)
    .replaceAll("{{context_en}}", context.en)
    .replaceAll("{{local_section}}", localSection);

  // Un marqueur résiduel = un câblage oublié. Mieux vaut échouer ici que d'envoyer
  // « {{cultures}} » à Claude. (On perd le typecheck sur les interpolations ; ce
  // garde-fou attrape la même classe d'erreur, en plus large.)
  const leftover = out.match(/\{\{(\w+)\}\}/);
  if (leftover) {
    throw new Error(`Prompt template: unsubstituted marker ${leftover[0]}`);
  }
  return out;
}

// ── Timeline normalization ────────────────────────────────────────────────────

/**
 * Identity key of a track value — mirrors entityKey() in @strabon/shared.
 * QID first (the reliable key), normalised name as fallback.
 */
function entityKeyOf(value: any): string {
  if (value == null) return "";
  if (typeof value !== "object") return normName(String(value));
  if (value.wikidata) return `qid:${value.wikidata}`;
  if (value.name) return `name:${normName(value.name)}`;
  if (value.text) return `name:${normName(value.text)}`;
  return "";
}

function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * site_type: drop a `to` that is redundant (>= the next entry's `from`), i.e. the
 * occupation is continuous and the next entry closes this one anyway.
 */
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

/**
 * Co-occurrent tracks (religion, language): the `to` is MEANINGFUL — it marks the
 * disappearance of an entity, or the moment a generic trunk is superseded by a named
 * branch (Islam closed at 800, when Sunni Islam appears).
 *
 * The model, told to close a trunk, does NOT edit the original entry — it emits a
 * SECOND one. Two shapes observed:
 *
 *   A) Same `from`, one closed and one open:
 *        Paris: "Christianity" 250→null  AND  "Christianity" 250→380
 *      ⇒ the closed one is the corrected version. Keep it, drop the open one.
 *
 *   B) A ZERO-LENGTH entry carrying the closing date:
 *        Shamakhi: "Islam" 642→null  AND  "Islam" 800→800
 *      ⇒ the "800→800" entry is not an entity present for zero years; it is an ORDER to
 *        close Islam at 800. Carry its `to` back onto the open entry, then drop it.
 *
 * Both are the same intent expressed differently, and both must end as ONE entry with a
 * `to`. Order matters below: fold the zero-length entries FIRST (they are instructions),
 * then resolve same-`from` duplicates, then sanity-check what is left.
 */
function normalizeCooccurrentTo(entries: any[]): any[] {
  let sorted = [...entries].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));

  // ── 1. Zero-length entries are CLOSING INSTRUCTIONS, not entries. ───────────
  //    Push their date onto the latest still-open entry of the same entity that
  //    starts before them, then discard them.
  const zeroLength = sorted.filter((e) => e.to != null && e.to <= e.from);

  for (const z of zeroLength) {
    const key = entityKeyOf(z.value);
    let target: any;
    for (const e of sorted) {
      if (e === z) continue;
      if (entityKeyOf(e.value) !== key) continue;
      if (e.from >= z.from) continue;
      if (e.to != null) continue; // already closed
      // Latest open entry of this entity starting before the closing date.
      if (!target || e.from > target.from) target = e;
    }
    if (target) target.to = z.from;
  }

  sorted = sorted.filter((e) => !zeroLength.includes(e));

  // ── 2. Same entity, same `from`: one closed, one open ⇒ keep the closed one. ─
  const closedKeys = new Set<string>();
  for (const e of sorted) {
    if (e.to != null) closedKeys.add(`${entityKeyOf(e.value)}@${e.from}`);
  }
  sorted = sorted.filter(
    (e) => e.to != null || !closedKeys.has(`${entityKeyOf(e.value)}@${e.from}`),
  );

  // ── 3. Sanity-check the surviving `to` values. ──────────────────────────────
  return sorted.map((e, i) => {
    if (e.to == null) return e;

    const strip = () => {
      const { to, ...rest } = e;
      return rest;
    };

    // Anything still non-positive in length is junk (step 1 consumed the meaningful ones).
    if (e.to <= e.from) return strip();

    // A later entry of the SAME entity supersedes this one anyway (role change), so a
    // `to` at or beyond its `from` is redundant. A `to` STRICTLY BEFORE it is KEPT — it
    // is a real intra-entity gap (Judaism in Paris: expelled 1394, back in 1791).
    const key = entityKeyOf(e.value);
    let nextSame: any;
    for (let j = i + 1; j < sorted.length; j++) {
      if (entityKeyOf(sorted[j].value) === key) {
        nextSame = sorted[j];
        break;
      }
    }
    if (nextSame && e.to >= nextSame.from) return strip();

    return e;
  });
}

/** Step tracks: `to` is meaningless. Remove it. */
function stripTo(entries: any[]): any[] {
  return entries.map((e: any) => {
    if (e.to == null) return e;
    const { to, ...rest } = e;
    return rest;
  });
}

// Closed enum — mirrors EventType in @strabon/shared. An event whose type is not in
// this set is DROPPED, not coerced: the prompt tells the model to omit rather than
// force a fit, and a mis-typed event is worse than a missing one (it enters the
// atlas as a fact of the wrong kind, invisibly).
const EVENT_TYPES = new Set([
  "destruction",
  "fire",
  "earthquake",
  "flood",
  "plague",
  "siege",
  "conquest",
  "massacre",
  "founding",
  "refounding",
  "abandonment",
  "expulsion",
  "depopulation",
  "revolution",
  "annexation",
  "discovery",
]);

function normalizeEvents(events: any): any[] {
  if (!Array.isArray(events)) return [];
  return events.filter(
    (e: any) => typeof e?.type === "string" && EVENT_TYPES.has(e.type),
  );
}

/**
 * missing_entities: drop empty `proposed_qid` strings. The model writes "" rather
 * than omitting the field — same dodge as `wikidata: ""`. An empty string is not a
 * hypothesis; it would just noise up the verification pass.
 */
function normalizeMissingEntities(missing: any): any[] {
  if (!Array.isArray(missing)) return [];
  return missing
    .filter((m: any) => m && typeof m.name === "string" && m.name.trim())
    .map((m: any) => {
      const qid =
        typeof m.proposed_qid === "string" ? m.proposed_qid.trim() : "";
      if (qid) return { ...m, proposed_qid: qid };
      const { proposed_qid, ...rest } = m;
      return rest;
    });
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

// Les pistes escalier CLOSABLES gardent leur `to` : il marque la fin de l'entité,
// sans successeur (la culture mérovingienne s'éteint en 751 et rien ne la
// remplace — l'histoire documentée prend le relais). Sans lui, la dernière entrée
// court jusqu'à la fin de l'occupation.
const CLOSABLE_STEP_TRACKS = ["polity", "culture"] as const;
const PLAIN_STEP_TRACKS = ["name", "population"] as const;
const COOCCURRENT_TRACKS = ["religion", "language"] as const;

export function normalizeTimelineV2(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;

  // Pass through rejection objects untouched
  if (raw.rejection) return raw;

  let tl = raw;
  if (raw.tracks && typeof raw.tracks === "object") {
    tl = { ...raw.tracks };
  }

  for (const key of TRACK_KEYS) {
    if (Array.isArray(tl[key])) {
      tl[key] = { entries: tl[key] };
    }
  }

  const result: any = {};
  for (const key of [...TRACK_KEYS, "events", "missing_entities"]) {
    if (tl[key] !== undefined) result[key] = tl[key];
  }

  // Pistes escalier NON closables : `to` n'a aucun sens — un nom n'est pas fermé,
  // il est remplacé. On le retire.
  for (const key of PLAIN_STEP_TRACKS) {
    if (result[key]?.entries) {
      result[key].entries = stripTo(result[key].entries);
    }
  }

  // Pistes escalier CLOSABLES : `to` = fin de l'entité. On le garde, en le
  // contrôlant comme sur les co-occurrentes (to >= from, pas de to redondant).
  for (const key of CLOSABLE_STEP_TRACKS) {
    if (result[key]?.entries) {
      result[key].entries = normalizeCooccurrentTo(result[key].entries);
    }
  }

  // Co-occurrent tracks: `to` marks disappearance — KEEP it, sanity-check only.
  for (const key of COOCCURRENT_TRACKS) {
    if (result[key]?.entries) {
      result[key].entries = normalizeCooccurrentTo(result[key].entries);
    }
  }

  // site_type: `to` marks an occupation hiatus — drop redundant contiguous ones.
  if (result.site_type?.entries) {
    result.site_type.entries = normalizeSiteTypeTo(result.site_type.entries);
  }

  // Events: drop any whose type is outside the closed enum.
  if (result.events !== undefined) {
    result.events = normalizeEvents(result.events);
  }

  // missing_entities: drop empty proposed_qid strings and nameless entries.
  if (result.missing_entities !== undefined) {
    result.missing_entities = normalizeMissingEntities(result.missing_entities);
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
  return TRACK_KEYS.every((t) => !timeline[t]?.entries?.length);
}
