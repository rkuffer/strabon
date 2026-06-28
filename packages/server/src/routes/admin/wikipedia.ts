// packages/server/src/routes/admin/wikipedia.ts
// Pipeline de récupération et filtrage du contenu Wikipedia pour l'extraction LLM.
//
// Flow :
//   Phase 1 — Découverte  : Wikidata sitelinks → titres EN + langue locale
//   Phase 2 — Routing     : Haiku sélectionne les sections pertinentes
//   Phase 3 — Fetch ciblé : contenu des sections sélectionnées + détection {{main}}
//
// Exporté : buildWikipediaContext()

import Anthropic from "@anthropic-ai/sdk";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKI_API = (lang: string) => `https://${lang}.wikipedia.org/w/api.php`;
const UA = "Strabon/1.0";
const FETCH_TIMEOUT = 10_000;

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

// ── Phase 2 : Routing Haiku — sélection des sections pertinentes ──────────────
async function selectRelevantSections(
  sectionsEn: WikiSection[],
  sectionsLocal: WikiSection[],
  localLang: string,
  client: Anthropic,
  routerModel: string,
): Promise<{ enIndices: number[]; localIndices: number[] }> {
  if (!sectionsEn.length && !sectionsLocal.length) {
    return { enIndices: [], localIndices: [] };
  }

  const formatList = (sections: WikiSection[], label: string) =>
    sections.length
      ? `${label}:\n${sections.map((s) => `  [${s.index}] ${"#".repeat(s.level)} ${s.title}`).join("\n")}`
      : "";

  const prompt = `You are selecting Wikipedia sections relevant to the historical timeline of an archaeological site or historical city.

Return ONLY a JSON object with this exact structure, no prose:
{"en": [list of integer section indices], "local": [list of integer section indices]}

Select sections that contain: history, archaeology, founding, ancient/medieval/modern periods, etymology, names, notable events, rulers, conquests, cultural periods.
Exclude: demographics, economy, infrastructure, sports, transport, education, contemporary politics, climate, notable people (unless historical rulers).

${formatList(sectionsEn, "English sections")}
${localLang ? formatList(sectionsLocal, `Local sections (${localLang})`) : ""}`;

  const response = await client.messages.create({
    model: routerModel,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text)
    .join("");

  try {
    const parsed = JSON.parse(text.trim());
    return {
      enIndices: Array.isArray(parsed.en) ? parsed.en : [],
      localIndices: Array.isArray(parsed.local) ? parsed.local : [],
    };
  } catch {
    // Fallback : prendre les 5 premières sections de chaque
    return {
      enIndices: sectionsEn.slice(0, 5).map((s) => s.index),
      localIndices: sectionsLocal.slice(0, 5).map((s) => s.index),
    };
  }
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

  // Récupérer et filtrer les sections de l'article dédié
  const sections = await fetchSections(lang, mainTitle);
  if (!sections.length) return "";

  // Réutiliser Haiku pour filtrer les sections de l'article dédié
  const { enIndices } = await selectRelevantSections(
    sections,
    [],
    "",
    client,
    routerModel,
  );

  const indices = enIndices.length
    ? enIndices
    : sections.slice(0, 8).map((s) => s.index);

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

  // Langue locale : première disponible selon la priorité pays
  const langPriority = COUNTRY_TO_LANG[country] ?? [];
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

  // Sections locales en parallèle si disponibles
  const sectionsLocal = localLang
    ? await fetchSections(localLang, localTitle)
    : [];

  // Phase 2 : Routing Haiku
  const { enIndices, localIndices } = await selectRelevantSections(
    sectionsEn,
    sectionsLocal,
    localLang,
    client,
    routerModel,
  );

  console.log(
    `[wiki] sections EN trouvées: ${sectionsEn.length} — titres: [${sectionsEn
      .slice(0, 8)
      .map((s) => s.title)
      .join(", ")}]`,
  );
  console.log(
    `[wiki] sections EN sélectionnées par Haiku: [${enIndices.join(", ")}]`,
  );
  if (localLang) {
    console.log(
      `[wiki] sections ${localLang} sélectionnées par Haiku: [${localIndices.join(", ")}]`,
    );
  }

  if (!enIndices.length && sectionsEn.length > 0) {
    console.warn(
      `[wiki] ⚠ Haiku n'a sélectionné aucune section EN parmi ${sectionsEn.length} disponibles — fallback sur les 5 premières`,
    );
  }

  // Phase 3 : Fetch ciblé en parallèle
  const [enContents, localContents] = await Promise.all([
    Promise.all(
      (enIndices.length
        ? enIndices
        : sectionsEn.slice(0, 6).map((s) => s.index)
      ).map((i) => fetchSectionContent("en", canonicalTitleEn, i)),
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
  const mainMatch = enRaw.match(MAIN_ARTICLE_RE);
  if (mainMatch) {
    console.log(`[wiki] article dédié détecté: "${mainMatch[1].trim()}"`);
  }
  const mainArticleContent = await fetchMainArticle(
    "en",
    enRaw,
    client,
    routerModel,
  );
  // (fetchMainArticle utilise le contenu pour détecter {{main}}, pas le titre)

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
  };
}
