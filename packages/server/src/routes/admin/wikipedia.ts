// packages/server/src/routes/admin/wikipedia.ts
// Pipeline de récupération et filtrage du contenu Wikipedia pour l'extraction LLM.
//
// Flow :
//   Phase 1 — Découverte  : Wikidata sitelinks → titres EN + langue locale
//   Phase 2 — Routing     : Haiku sélectionne les sections pertinentes
//                           (fallback déterministe par mots-clés si échec)
//   Phase 3 — Fetch ciblé : contenu des sections sélectionnées + détection {{main}}
//
// Exporté : buildWikipediaContext()

import Anthropic from "@anthropic-ai/sdk";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKI_API = (lang: string) => `https://${lang}.wikipedia.org/w/api.php`;
const UA = "Strabon/1.0";
const FETCH_TIMEOUT = 20_000;

// ── Mapping pays → langue locale prioritaire ──────────────────────────────────
// Inspiré de COUNTRY_LABELS dans enrich.ts, étendu avec les codes langue
const COUNTRY_TO_LANG: Record<string, string[]> = {
  // Europe
  France: ["fr"],
  Spain: ["es"],
  Portugal: ["pt"],
  Italy: ["it"],
  Germany: ["de"],
  Austria: ["de"],
  Greece: ["el"],
  "United Kingdom": ["en"], // déjà en EN, on skip
  Russia: ["ru"],
  Ukraine: ["uk"],
  Turkey: ["tr"],
  // Moyen-Orient
  Egypt: ["ar"],
  Iraq: ["ar"],
  Syria: ["ar"],
  Lebanon: ["ar"],
  Jordan: ["ar"],
  Israel: ["he", "ar"],
  Iran: ["fa"],
  // Asie
  China: ["zh"],
  Japan: ["ja"],
  India: ["hi"],
  Vietnam: ["vi"],
  Thailand: ["th"],
  Cambodia: ["km"],
  // Amériques
  Mexico: ["es"],
  Brazil: ["pt"],
  Peru: ["es"],
  // Afrique du Nord
  Morocco: ["ar"],
  Algeria: ["ar"],
  Tunisia: ["ar"],
  Libya: ["ar"],
};

// ── Type de retour public ─────────────────────────────────────────────────────
export type WikipediaContext = {
  en: string; // contenu EN filtré (sections hist. + article dédié si trouvé)
  local: string; // contenu langue locale filtré
  localLang: string; // code ISO langue locale (ex: "ar", "fr") ou "" si non trouvé
  routerSource: RouterSource; // "router" | "keyword-fallback" — traçabilité
};

// ── Fetch avec timeout ────────────────────────────────────────────────────────
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Phase 1a : Wikidata sitelinks ─────────────────────────────────────────────
// Retourne un map lang → titre Wikipedia (ex: { "ar": "بعلبك", "fr": "Baalbek" })
async function fetchSitelinks(
  wikidataId: string,
): Promise<Map<string, string>> {
  const url = `${WIKIDATA_API}?${new URLSearchParams({
    action: "wbgetentities",
    ids: wikidataId,
    props: "sitelinks",
    format: "json",
    origin: "*",
  })}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const data = await res.json();

  const sitelinks = data?.entities?.[wikidataId]?.sitelinks ?? {};
  const result = new Map<string, string>();

  for (const [key, val] of Object.entries(sitelinks) as any[]) {
    // key = "frwiki", "arwiki", "enwiki"...
    const lang = key.replace("wiki", "");
    result.set(lang, val.title);
  }

  return result;
}

// ── Phase 1b : Liste des sections d'une page Wikipedia ───────────────────────
type WikiSection = { index: number; title: string; level: number };

async function fetchSections(
  lang: string,
  title: string,
): Promise<WikiSection[]> {
  const url = `${WIKI_API(lang)}?${new URLSearchParams({
    action: "parse",
    page: title,
    prop: "sections",
    format: "json",
    origin: "*",
  })}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) return [];
  const data = await res.json();

  return (data?.parse?.sections ?? []).map((s: any) => ({
    index: parseInt(s.index),
    title: s.line,
    level: parseInt(s.toclevel),
  }));
}

// ── Phase 2a : Fallback déterministe — sélection par mots-clés ────────────────
// Utilisé quand le routeur Haiku échoue (parse error, troncature, sélection vide).
// NE JAMAIS retomber sur "les N premières sections" : sur un article de ville ce
// sont toujours Géographie/Climat/Hydrographie, soit le pire contenu possible
// pour une timeline historique. C'était le bug d'origine.

const HISTORY_TITLE_PATTERNS: RegExp[] = [
  // English
  /\bhistor/i,
  /\borigin/i,
  /\bfound(ing|ation)/i,
  /\bantiquit/i,
  /\bprehistor/i,
  /\bmiddle ages\b/i,
  /\bmedieval\b/i,
  /\btoponym/i,
  /\betymolog/i,
  /\bname\b/i,
  /\barchaeolog/i,
  /\bancient\b/i,
  /\bmodern (era|period)\b/i,
  /\bcentury\b/i,
  /\bconquest\b/i,
  /\bempire\b/i,
  /\bdynast/i,
  /\bperiod\b/i,
  /\bera\b/i,
  // French
  /\bhistoire\b/i,
  /\borigines?\b/i,
  /\bfondation\b/i,
  /\bantiquité\b/i,
  /\bmoyen[- ]âge\b/i,
  /\btoponymie\b/i,
  /\bétymologie\b/i,
  /\bpréhistoire\b/i,
  /\bépoque\b/i,
  /\bsiècle\b/i,
  // Spanish / Italian / Portuguese
  /\bhistoria\b/i,
  /\bstoria\b/i,
  /\bhistória\b/i,
  /\borígenes?\b/i,
  /\bedad media\b/i,
  /\bmedioevo\b/i,
  /\bfundación\b/i,
  // German
  /\bgeschichte\b/i,
  /\bmittelalter\b/i,
  /\bantike\b/i,
  /\bnamensherkunft\b/i,
  // Arabic / Hebrew / Persian
  /تاريخ/,
  /التسمية/,
  /العصر/,
  /היסטוריה/,
  /تاریخ/,
  // Russian / Ukrainian / Greek
  /истори/i,
  /істор/i,
  /ιστορία/i,
  // CJK
  /歴史/,
  /历史/,
  /歷史/,
  /역사/,
];

// Titres explicitement non voulus, même si un pattern large ci-dessus matche.
const EXCLUDE_TITLE_PATTERNS: RegExp[] = [
  /\bclimat/i,
  /\bgeograph/i,
  /\bgéographie\b/i,
  /\bhydrograph/i,
  /\bdemograph/i,
  /\bdémographie\b/i,
  /\bpopulation\b/i,
  /\beconom/i,
  /\béconomie\b/i,
  /\btransport/i,
  /\bsport/i,
  /\beducation\b/i,
  /\benseignement\b/i,
  /\binfrastructure/i,
  /\btwin towns\b/i,
  /\bjumelage/i,
  /\bsee also\b/i,
  /\bvoir aussi\b/i,
  /\breferences?\b/i,
  /\bbibliograph/i,
  /\bexternal links\b/i,
  /\bnotes\b/i,
  /\bgallery\b/i,
  /\bmedia\b/i,
  /\bnotable people\b/i,
  /\bpersonnalités\b/i,
  /\bhéraldique\b/i,
  /\bpolitics\b/i,
  /\bpolitique\b/i,
];

function selectSectionsByKeyword(sections: WikiSection[]): number[] {
  if (!sections.length) return [];

  const isHistorical = (title: string) =>
    !EXCLUDE_TITLE_PATTERNS.some((re) => re.test(title)) &&
    HISTORY_TITLE_PATTERNS.some((re) => re.test(title));

  const selected = new Set<number>();

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!isHistorical(s.title)) continue;

    selected.add(s.index);

    // Inclure les descendants : toute section suivante plus profonde que
    // celle-ci, jusqu'à retomber sur un niveau égal ou supérieur.
    // (ex: "History" > "Antiquity", "Middle Ages", "Modern era")
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= s.level) break;
      selected.add(sections[j].index);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

// ── Phase 2b : Extraction JSON robuste ───────────────────────────────────────
// Le modèle peut entourer l'objet de prose ou d'une fence ```json. On prend le
// DERNIER bloc {...} équilibré : c'est le corrigé si le modèle s'est auto-révisé.
function extractJsonObject(text: string): any | null {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* on continue */
  }

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fenced.length) {
    try {
      return JSON.parse(fenced[fenced.length - 1][1].trim());
    } catch {
      /* on continue */
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* on continue */
    }
  }

  return null;
}

// ── Phase 2c : Routing Haiku — sélection des sections pertinentes ─────────────
type RouterSource = "router" | "keyword-fallback";

type SectionSelection = {
  enIndices: number[];
  localIndices: number[];
  source: RouterSource;
};

async function selectRelevantSections(
  sectionsEn: WikiSection[],
  sectionsLocal: WikiSection[],
  localLang: string,
  client: Anthropic,
  routerModel: string,
): Promise<SectionSelection> {
  if (!sectionsEn.length && !sectionsLocal.length) {
    return { enIndices: [], localIndices: [], source: "router" };
  }

  const keywordFallback = (reason: string): SectionSelection => {
    const enIndices = selectSectionsByKeyword(sectionsEn);
    const localIndices = selectSectionsByKeyword(sectionsLocal);
    console.warn(
      `[wiki] ⚠ router FAILED (${reason}) — deterministic keyword fallback: ` +
        `EN [${enIndices.join(", ")}], ${localLang || "local"} [${localIndices.join(", ")}]`,
    );
    return { enIndices, localIndices, source: "keyword-fallback" };
  };

  const formatList = (sections: WikiSection[], label: string) =>
    sections.length
      ? `${label}:\n${sections
          .map((s) => `  [${s.index}] ${"#".repeat(s.level)} ${s.title}`)
          .join("\n")}`
      : "";

  const prompt = `You are selecting Wikipedia sections relevant to the historical timeline of an archaeological site or historical city.

Return ONLY a JSON object with this exact structure, no prose, no markdown fence:
{"en": [list of integer section indices], "local": [list of integer section indices]}

Select sections that contain: history, archaeology, founding, ancient/medieval/modern periods, etymology, names, notable events, rulers, conquests, cultural periods.
Include the subsections of any selected section.
Exclude: demographics, economy, infrastructure, sports, transport, education, contemporary politics, geography, climate, hydrography, notable people (unless historical rulers).

You MUST select at least one section per list when a plausible candidate exists.

${formatList(sectionsEn, "English sections")}
${localLang ? formatList(sectionsLocal, `Local sections (${localLang})`) : ""}`;

  let text = "";
  try {
    const response = await client.messages.create({
      model: routerModel,
      max_tokens: 1024, // était 256 — la troncature produisait du JSON invalide
      messages: [{ role: "user", content: prompt }],
    });

    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[wiki] ⚠ router response hit max_tokens — likely truncated JSON`,
      );
    }
  } catch (err) {
    return keywordFallback(`API error: ${(err as Error).message}`);
  }

  const parsed = extractJsonObject(text);

  if (!parsed) {
    console.warn(
      `[wiki] ⚠ router raw response (unparseable, ${text.length} chars):\n${text.slice(0, 800)}`,
    );
    return keywordFallback("JSON parse failed");
  }

  // Valider les indices contre les sections réellement existantes : élimine les
  // indices hallucinés ou hors bornes.
  const validIndices = (raw: unknown, sections: WikiSection[]): number[] => {
    if (!Array.isArray(raw)) return [];
    const known = new Set(sections.map((s) => s.index));
    return raw
      .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
      .filter((n) => Number.isFinite(n) && known.has(n))
      .sort((a, b) => a - b);
  };

  const enIndices = validIndices(parsed.en, sectionsEn);
  const localIndices = validIndices(parsed.local, sectionsLocal);

  // Une sélection valide mais vide est aussi mauvaise qu'un échec de parse.
  if (!enIndices.length && sectionsEn.length > 0) {
    console.warn(
      `[wiki] ⚠ router returned 0 EN sections out of ${sectionsEn.length}`,
    );
    return keywordFallback("empty EN selection");
  }

  return { enIndices, localIndices, source: "router" };
}

// ── Phase 3a : Fetch du contenu d'une section ────────────────────────────────
async function fetchSectionContent(
  lang: string,
  title: string,
  index: number,
): Promise<string> {
  const url = `${WIKI_API(lang)}?${new URLSearchParams({
    action: "parse",
    page: title,
    prop: "wikitext",
    section: String(index),
    format: "json",
    origin: "*",
  })}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) return "";
  const data = await res.json();
  return data?.parse?.wikitext?.["*"] ?? "";
}

// ── Phase 3b : Détection et fetch d'un article dédié ({{main|...}}) ──────────
const MAIN_ARTICLE_RE = /\{\{(?:main|further|see also)\|([^|}]+)/i;

async function fetchMainArticle(
  lang: string,
  content: string,
  client: Anthropic,
  routerModel: string,
): Promise<string> {
  const match = content.match(MAIN_ARTICLE_RE);
  if (!match) return "";

  const mainTitle = match[1].trim();

  const sections = await fetchSections(lang, mainTitle);
  if (!sections.length) return "";

  // Réutiliser le routeur pour filtrer les sections de l'article dédié
  const { enIndices } = await selectRelevantSections(
    sections,
    [],
    "",
    client,
    routerModel,
  );

  // L'article dédié est historique par nature : si le routeur ET le fallback
  // mots-clés reviennent vides, on prend tout plutôt qu'un préfixe arbitraire.
  const indices = enIndices.length ? enIndices : sections.map((s) => s.index);

  console.log(
    `[wiki] article dédié "${mainTitle}" — ${indices.length}/${sections.length} sections retenues`,
  );

  const contents = await Promise.all(
    indices.map((i) => fetchSectionContent(lang, mainTitle, i)),
  );

  return contents.filter(Boolean).join("\n\n").slice(0, 8000);
}

// ── Nettoyage du wikitext ─────────────────────────────────────────────────────
// Retire les templates, références et balises pour ne garder que le texte utile
function cleanWikitext(raw: string): string {
  return raw
    .replace(/\{\{[^}]*\}\}/g, "") // templates {{...}}
    .replace(/<ref[^>]*>.*?<\/ref>/gs, "") // références <ref>...</ref>
    .replace(/<[^>]+>/g, "") // balises HTML
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2") // liens [[title|text]] → text
    .replace(/={2,}/g, "") // titres de sections ===
    .replace(/\n{3,}/g, "\n\n") // sauts de ligne multiples
    .trim();
}

// ── Seuil de résumé ──────────────────────────────────────────────────────────
// Si le contenu total dépasse ce seuil, on demande à Haiku un résumé structuré
// avant de passer le contexte à Sonnet
const SUMMARY_THRESHOLD = 60_000; // caractères
const SUMMARY_TARGET = 8_000; // taille max du résumé produit par Haiku

// ── Résumé intermédiaire par Haiku ────────────────────────────────────────────
async function summarizeForTimeline(
  title: string,
  enContent: string,
  localContent: string,
  localLang: string,
  client: Anthropic,
  routerModel: string,
): Promise<{ en: string; local: string }> {
  const summarize = async (text: string, lang: string): Promise<string> => {
    if (!text) return "";
    const prompt = `You are preparing source material for historical timeline extraction about "${title}".

Summarize the following Wikipedia content keeping ONLY chronologically structured information:
- Dates and periods of occupation, control, or cultural affiliation
- Political entities: empires, kingdoms, republics, city-states that controlled the site
- Rulers, conquests, and transfers of power with dates
- Archaeological cultures and civilisations with their periods
- Vernacular and historical names of the site with the periods they were used
- Population estimates with dates
- Notable historical events (destructions, foundations, sieges, earthquakes...)

Discard entirely: modern infrastructure, tourism, sports, contemporary demographics, geography, economy, religion as practiced today, and anything without a historical date.

Output structured prose organized chronologically. Be concise but preserve all dates and entity names. Target ~${SUMMARY_TARGET} characters.

Content (${lang}):
---
${text}
---`;

    const response = await client.messages.create({
      model: routerModel,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .slice(0, SUMMARY_TARGET);
  };

  const [enSummary, localSummary] = await Promise.all([
    summarize(enContent, "English"),
    localContent ? summarize(localContent, localLang) : Promise.resolve(""),
  ]);

  return { en: enSummary, local: localSummary };
}

// ── Fonction principale exportée ──────────────────────────────────────────────
export async function buildWikipediaContext(
  wikidataId: string,
  country: string,
  titleEn: string,
  client: Anthropic,
  routerModel: string,
  langCode?: string,
): Promise<WikipediaContext> {
  // Phase 1 : Découverte — d'abord les sitelinks pour obtenir le titre EN canonique
  const sitelinks = await fetchSitelinks(wikidataId);

  // Utiliser le titre EN depuis les sitelinks Wikidata plutôt que titleEn
  // (évite les problèmes d'encodage de caractères spéciaux ex: Şanlıurfa)
  const canonicalTitleEn = sitelinks.get("en") ?? titleEn;
  if (canonicalTitleEn !== titleEn) {
    console.log(
      `[wiki] titre EN canonique: "${canonicalTitleEn}" (passé: "${titleEn}")`,
    );
  }

  const sectionsEn = await fetchSections("en", canonicalTitleEn);

  // A langCode passed explicitly (from the `countries` table) wins over the
  // internal country-name mapping, which is incomplete by construction.
  const langPriority = langCode
    ? [langCode, ...(COUNTRY_TO_LANG[country] ?? [])]
    : (COUNTRY_TO_LANG[country] ?? []);
  let localLang = "";
  let localTitle = "";

  for (const lang of langPriority) {
    if (lang === "en") continue; // déjà couvert
    if (sitelinks.has(lang)) {
      localLang = lang;
      localTitle = sitelinks.get(lang)!;
      break;
    }
  }

  console.log(
    `[wiki] ${wikidataId} sitelinks: ${sitelinks.size} langues disponibles`,
  );
  if (localLang) {
    console.log(
      `[wiki] langue locale sélectionnée: ${localLang} → "${localTitle}"`,
    );
  } else {
    console.log(
      `[wiki] aucune langue locale trouvée pour country="${country}"`,
    );
  }

  // Sections locales si disponibles
  const sectionsLocal = localLang
    ? await fetchSections(localLang, localTitle)
    : [];

  // Log complet des sections disponibles (plus de troncature à 8 : c'est elle
  // qui masquait le fait que History/Toponymy/Origins étaient bien présentes)
  console.log(
    `[wiki] sections EN trouvées: ${sectionsEn.length} — titres: [${sectionsEn
      .map((s) => s.title)
      .join(", ")}]`,
  );
  if (localLang) {
    console.log(
      `[wiki] sections ${localLang} trouvées: ${sectionsLocal.length} — titres: [${sectionsLocal
        .map((s) => s.title)
        .join(", ")}]`,
    );
  }

  // Phase 2 : Routing Haiku (avec fallback déterministe intégré)
  const { enIndices, localIndices, source } = await selectRelevantSections(
    sectionsEn,
    sectionsLocal,
    localLang,
    client,
    routerModel,
  );

  const titleOf = (sections: WikiSection[], i: number) =>
    sections.find((s) => s.index === i)?.title ?? "?";

  console.log(
    `[wiki] sections EN retenues (${source}): ` +
      enIndices.map((i) => `[${i}] ${titleOf(sectionsEn, i)}`).join(" | "),
  );
  if (localLang) {
    console.log(
      `[wiki] sections ${localLang} retenues (${source}): ` +
        localIndices
          .map((i) => `[${i}] ${titleOf(sectionsLocal, i)}`)
          .join(" | "),
    );
  }

  if (!enIndices.length && !localIndices.length) {
    console.error(
      `[wiki] ✖ AUCUNE section historique trouvée pour ${wikidataId} ` +
        `(${sectionsEn.length} EN / ${sectionsLocal.length} ${localLang || "local"}) — ` +
        `contexte vide, extraction non fiable`,
    );
  }

  // Phase 3 : Fetch ciblé — plus aucun fallback silencieux ici.
  // Si les indices sont vides, on assume le contexte vide plutôt que d'injecter
  // de la géographie (ancien `slice(0, 6)`).
  const [enContents, localContents] = await Promise.all([
    Promise.all(
      enIndices.map((i) => fetchSectionContent("en", canonicalTitleEn, i)),
    ),
    localLang && localIndices.length
      ? Promise.all(
          localIndices.map((i) =>
            fetchSectionContent(localLang, localTitle, i),
          ),
        )
      : Promise.resolve([]),
  ]);

  const enRaw = enContents.filter(Boolean).join("\n\n");
  const localRaw = localContents.filter(Boolean).join("\n\n");

  // Détection article dédié dans le contenu EN
  const mainArticleContent = await fetchMainArticle(
    "en",
    enRaw,
    client,
    routerModel,
  );

  // Assemblage final avec nettoyage
  const enCleaned = cleanWikitext(enRaw);
  const localCleaned = cleanWikitext(localRaw);
  const mainCleaned = mainArticleContent; // déjà nettoyé dans fetchMainArticle

  const enAssembled = [enCleaned, mainCleaned]
    .filter(Boolean)
    .join("\n\n--- From dedicated history article ---\n\n");

  const totalChars = enAssembled.length + localCleaned.length;
  console.log(
    `[wiki] contenu brut assemblé — total: ${totalChars} chars (EN: ${enAssembled.length}, local: ${localCleaned.length})`,
  );

  let enFinal: string;
  let localFinal: string;

  if (totalChars > SUMMARY_THRESHOLD) {
    console.log(
      `[wiki] ⚡ seuil dépassé (${totalChars} > ${SUMMARY_THRESHOLD}) — résumé Haiku en cours...`,
    );
    const t = Date.now();
    const summarized = await summarizeForTimeline(
      titleEn,
      enAssembled,
      localCleaned,
      localLang,
      client,
      routerModel,
    );
    enFinal = summarized.en;
    localFinal = summarized.local;
    console.log(
      `[wiki] ✓ résumé en ${Date.now() - t}ms — EN: ${enFinal.length} chars, local: ${localFinal.length} chars`,
    );
  } else {
    enFinal = enAssembled;
    localFinal = localCleaned;
    console.log(`[wiki] contenu sous le seuil — passage direct à Sonnet`);
  }

  console.log(
    `[wiki] contexte final — EN: ${enFinal.length} chars, local (${localLang || "none"}): ${localFinal.length} chars`,
  );

  return {
    en: enFinal,
    local: localFinal,
    localLang,
    routerSource: source,
  };
}
