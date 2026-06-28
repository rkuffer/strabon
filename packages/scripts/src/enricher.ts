import fs from "fs";
import path from "path";
import { Index, SiteEntry, WikidataEnrichment, WikiDate } from "./site-types";

// --- Config ---
const OUTPUT_DIR = path.join(__dirname, "../output");
const INDEX_FILE = path.join(OUTPUT_DIR, "index.json");
const LOG_FILE = path.join(OUTPUT_DIR, "enricher.log"); // log séparé de l'indexeur
const WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "WikiIndexer/1.0 (rodolphe.kuffer@example.com)";

// Langues ciblées pour les labels multilingues
const TARGET_LANGUAGES = [
  "en",
  "fr",
  "de",
  "es",
  "ar",
  "zh",
  "ru",
  "la",
  "grc",
  "fa",
  "tr",
  "it",
  "pt",
];

// Table de résolution rapide pour les pays les plus fréquents
const COUNTRY_LABELS: Record<string, string> = {
  Q17: "Japan",
  Q29: "Spain",
  Q30: "United States",
  Q31: "Belgium",
  Q32: "Luxembourg",
  Q33: "Finland",
  Q34: "Sweden",
  Q35: "Denmark",
  Q36: "Poland",
  Q37: "Lithuania",
  Q38: "Italy",
  Q39: "Switzerland",
  Q40: "Austria",
  Q41: "Greece",
  Q43: "Turkey",
  Q45: "Portugal",
  Q55: "Netherlands",
  Q64: "Germany",
  Q70: "Liechtenstein",
  Q77: "Uruguay",
  Q79: "Egypt",
  Q96: "Mexico",
  Q114: "Kenya",
  Q115: "Ethiopia",
  Q117: "Ghana",
  Q118: "Guinea",
  Q119: "Haiti",
  Q124: "Honduras",
  Q126: "Hungary",
  Q131: "Iceland",
  Q135: "Indonesia",
  Q137: "Iran",
  Q139: "Ireland",
  Q142: "France",
  Q145: "United Kingdom",
  Q148: "China",
  Q155: "Brazil",
  Q159: "Russia",
  Q163: "San Marino",
  Q165: "Serbia",
  Q170: "Slovakia",
  Q172: "Slovenia",
  Q183: "Germany",
  Q184: "Croatia",
  Q185: "Bulgaria",
  Q189: "Estonia",
  Q191: "Latvia",
  Q193: "Lithuania",
  Q212: "Ukraine",
  Q214: "Czech Republic",
  Q217: "Moldova",
  Q218: "Romania",
  Q219: "Bulgaria",
  Q221: "North Macedonia",
  Q222: "Albania",
  Q223: "Cyprus",
  Q224: "Bosnia and Herzegovina",
  Q225: "Montenegro",
  Q232: "Kazakhstan",
  Q233: "Uzbekistan",
  Q235: "Kyrgyzstan",
  Q236: "Tajikistan",
  Q237: "Turkmenistan",
  Q241: "Cuba",
  Q242: "Belize",
  Q244: "Barbados",
  Q245: "Jamaica",
  Q248: "Guyana",
  Q252: "Suriname",
  Q258: "South Africa",
  Q262: "Algeria",
  Q265: "Belarus",
  Q398: "United Arab Emirates",
  Q399: "Armenia",
  Q408: "Australia",
  Q414: "Argentina",
  Q419: "Peru",
  Q420: "Paraguay",
  Q423: "North Korea",
  Q424: "Cambodia",
  Q425: "Laos",
  Q432: "Tajikistan",
  Q668: "India",
  Q672: "Maldives",
  Q686: "Vanuatu",
  Q691: "Papua New Guinea",
  Q695: "Samoa",
  Q697: "Nauru",
  Q702: "Fiji",
  Q706: "Solomon Islands",
  Q709: "Kiribati",
  Q710: "Marshall Islands",
  Q712: "Tuvalu",
  Q713: "Micronesia",
  Q717: "Venezuela",
  Q733: "Paraguay",
  Q736: "Ecuador",
  Q739: "Colombia",
  Q743: "Bolivia",
  Q757: "Saint Vincent and the Grenadines",
  Q760: "Saint Lucia",
  Q763: "Saint Kitts and Nevis",
  Q766: "Trinidad and Tobago",
  Q769: "Grenada",
  Q771: "Dominica",
  Q774: "Guatemala",
  Q778: "Panama",
  Q783: "Costa Rica",
  Q784: "El Salvador",
  Q786: "Nicaragua",
  Q790: "Haiti",
  Q792: "Honduras",
  Q794: "Iran",
  Q796: "Iraq",
  Q800: "Nepal",
  Q801: "Israel",
  Q804: "Jordan",
  Q805: "Yemen",
  Q810: "Myanmar",
  Q811: "Eritrea",
  Q812: "Namibia",
  Q813: "Kyrgyzstan",
  Q817: "Bahrain",
  Q819: "Laos",
  Q820: "Cambodia",
  Q822: "Lebanon",
  Q824: "Maldives",
  Q826: "Oman",
  Q827: "Qatar",
  Q828: "Brunei",
  Q833: "Malaysia",
  Q836: "Mongolia",
  Q837: "Nepal",
  Q842: "Oman",
  Q843: "Pakistan",
  Q846: "Saudi Arabia",
  Q851: "Sri Lanka",
  Q858: "Syria",
  Q863: "Tajikistan",
  Q865: "Taiwan",
  Q869: "Thailand",
  Q878: "United Arab Emirates",
  Q881: "Vietnam",
  Q884: "South Korea",
  Q889: "Afghanistan",
  Q902: "Bangladesh",
  Q912: "Mali",
  Q916: "Angola",
  Q917: "Bhutan",
  Q924: "Tanzania",
  Q928: "Philippines",
  Q929: "Central African Republic",
  Q953: "Zambia",
  Q954: "Zimbabwe",
  Q958: "South Sudan",
  Q962: "Burkina Faso",
  Q963: "Burundi",
  Q967: "Rwanda",
  Q974: "Democratic Republic of the Congo",
  Q977: "Djibouti",
  Q983: "Equatorial Guinea",
  Q986: "Liberia",
  Q1000: "Gabon",
  Q1007: "Guinea-Bissau",
  Q1008: "Ivory Coast",
  Q1009: "Cameroon",
  Q1011: "Cape Verde",
  Q1013: "Lesotho",
  Q1016: "Libya",
  Q1019: "Madagascar",
  Q1020: "Malawi",
  Q1025: "Mauritania",
  Q1027: "Mauritius",
  Q1028: "Morocco",
  Q1029: "Mozambique",
  Q1030: "Namibia",
  Q1032: "Niger",
  Q1033: "Nigeria",
  Q1036: "Uganda",
  Q1037: "Rwanda",
  Q1039: "São Tomé and Príncipe",
  Q1041: "Senegal",
  Q1042: "Seychelles",
  Q1044: "Sierra Leone",
  Q1045: "Somalia",
  Q1049: "Sudan",
  Q1050: "Eswatini",
  Q1051: "Togo",
  Q1053: "Tunisia",
  Q1055: "South Africa",
  Q1058: "Algeria",
  Q1061: "Benin",
};

// ── Utilitaires ──────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message: string) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logMessage);
  process.stdout.write(logMessage);
};

const fetchWithRetry = async (url: string, retries = 3): Promise<any> => {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      if (response.status === 429) {
        log("⚠️  Rate limited (429). Attente 15s...");
        await delay(15000);
        if (retries > 0) return fetchWithRetry(url, retries - 1);
        throw new Error("Limite de requêtes atteinte.");
      }
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    log(`Erreur requête: ${error}`);
    await delay(5000);
    if (retries > 0) return fetchWithRetry(url, retries - 1);
    return null;
  }
};

// ── Logique Wikidata ─────────────────────────────────────────────────

const parseWikidataTime = (timeValue: any): WikiDate | undefined => {
  if (!timeValue?.time) return undefined;
  const match = timeValue.time.match(/^([+-])(\d+)/);
  if (!match) return undefined;
  const sign = match[1] === "-" ? -1 : 1;
  const year = sign * parseInt(match[2], 10);
  const precision = timeValue.precision ?? 9;
  const circa =
    timeValue.qualifiers?.P1480?.some(
      (q: any) => q.datavalue?.value?.id === "Q5727902",
    ) ?? false;
  return { year, precision, ...(circa && { circa: true }) };
};

const getClaimValue = (claims: any, prop: string): any => {
  const statements = claims?.[prop];
  if (!statements?.length) return undefined;
  const preferred = statements.find((s: any) => s.rank === "preferred");
  const statement =
    preferred ?? statements.find((s: any) => s.rank !== "deprecated");
  return statement?.mainsnak?.datavalue?.value;
};

const getAllClaimValues = (claims: any, prop: string): any[] => {
  return (claims?.[prop] ?? [])
    .filter((s: any) => s.rank !== "deprecated" && s.mainsnak?.datavalue?.value)
    .map((s: any) => s.mainsnak.datavalue.value);
};

const resolveEntityLabels = async (
  qids: string[],
): Promise<Map<string, string>> => {
  const result = new Map<string, string>();
  if (qids.length === 0) return result;
  const uniqueQids = [...new Set(qids)].filter(Boolean);
  const BATCH = 50;
  for (let i = 0; i < uniqueQids.length; i += BATCH) {
    const batch = uniqueQids.slice(i, i + BATCH);
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: batch.join("|"),
      props: "labels",
      languages: "en",
      format: "json",
      origin: "*",
    });
    const data = await fetchWithRetry(
      `${WIKIDATA_API_URL}?${params.toString()}`,
    );
    for (const [qid, entity] of Object.entries(data?.entities ?? {}) as any[]) {
      const label = entity?.labels?.en?.value;
      if (label) result.set(qid, label);
    }
    if (i + BATCH < uniqueQids.length) await delay(300);
  }
  return result;
};

const batchFetchWikidata = async (
  wikidataIds: string[],
): Promise<Map<string, WikidataEnrichment>> => {
  const result = new Map<string, WikidataEnrichment>();
  if (wikidataIds.length === 0) return result;

  const BATCH_SIZE = 50;
  for (let i = 0; i < wikidataIds.length; i += BATCH_SIZE) {
    const batch = wikidataIds.slice(i, i + BATCH_SIZE);
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: batch.join("|"),
      props: "labels|claims",
      languages: TARGET_LANGUAGES.join("|"),
      format: "json",
      origin: "*",
    });

    const data = await fetchWithRetry(
      `${WIKIDATA_API_URL}?${params.toString()}`,
    );
    if (!data?.entities) continue;

    const qidsToResolve: string[] = [];

    for (const [qid, entity] of Object.entries(data.entities) as any[]) {
      if (entity.missing) continue;
      const claims = entity.claims ?? {};
      const enrichment: WikidataEnrichment = {};

      // Labels multilingues
      const labels = entity.labels ?? {};
      const names: Record<string, string> = {};
      for (const lang of TARGET_LANGUAGES) {
        if (labels[lang]?.value) names[lang] = labels[lang].value;
      }
      if (Object.keys(names).length > 0) enrichment.names = names;

      // Coordonnées P625
      const coordValue = getClaimValue(claims, "P625");
      if (
        coordValue?.latitude != null &&
        coordValue?.globe === "http://www.wikidata.org/entity/Q2"
      ) {
        enrichment.coordinates = {
          lat: coordValue.latitude,
          lon: coordValue.longitude,
          precision: coordValue.precision,
        };
      }

      // Pays P17
      const countryQid = getClaimValue(claims, "P17")?.id;
      if (countryQid) {
        enrichment.country_qid = countryQid;
        enrichment.country = COUNTRY_LABELS[countryQid];
      }

      // Nom natif P1705
      const nativeLabel = getClaimValue(claims, "P1705");
      if (nativeLabel?.text) enrichment.native_label = nativeLabel.text;

      // Dates P571/P576
      const inceptionVal = getClaimValue(claims, "P571");
      if (inceptionVal) {
        const parsed = parseWikidataTime(inceptionVal);
        if (parsed) enrichment.inception = parsed;
      }
      const dissolutionVal = getClaimValue(claims, "P576");
      if (dissolutionVal) {
        const parsed = parseWikidataTime(dissolutionVal);
        if (parsed) enrichment.dissolution = parsed;
      }

      // Cultures P2596
      const cultureQids = getAllClaimValues(claims, "P2596")
        .map((v: any) => v?.id)
        .filter(Boolean);
      if (cultureQids.length > 0) {
        (enrichment as any)._cultureQids = cultureQids;
        qidsToResolve.push(...cultureQids);
      }

      // Type P31
      const typeQids = getAllClaimValues(claims, "P31")
        .map((v: any) => v?.id)
        .filter(Boolean);
      if (typeQids.length > 0) {
        (enrichment as any)._typeQids = typeQids;
        qidsToResolve.push(...typeQids);
      }

      result.set(qid, enrichment);
    }

    // Résoudre cultures et types en labels EN
    if (qidsToResolve.length > 0) {
      const labelMap = await resolveEntityLabels(qidsToResolve);
      for (const enrichment of result.values()) {
        const cultureQids: string[] = (enrichment as any)._cultureQids ?? [];
        if (cultureQids.length > 0) {
          enrichment.cultures = cultureQids
            .map((q) => labelMap.get(q))
            .filter((l): l is string => Boolean(l));
          delete (enrichment as any)._cultureQids;
        }
        const typeQids: string[] = (enrichment as any)._typeQids ?? [];
        if (typeQids.length > 0) {
          enrichment.site_type = typeQids
            .map((q) => labelMap.get(q))
            .filter((l): l is string => Boolean(l))[0];
          delete (enrichment as any)._typeQids;
        }
      }
    }

    if (i + BATCH_SIZE < wikidataIds.length) await delay(500);
  }

  return result;
};

// Détermine si une entrée doit être enrichie.
// sinceDate : si fourni, ré-enrichit les entrées enrichies AVANT cette date
// (permet de mettre à jour les entrées ajoutées avant une date donnée)
const needsEnrichment = (entry: SiteEntry, sinceDate?: Date): boolean => {
  if (!entry.wikidata_enriched_at) return true; // jamais enrichie
  if (!sinceDate) return false; // déjà enrichie, pas de filtre date
  return new Date(entry.wikidata_enriched_at) < sinceDate; // enrichie avant la date limite
};

// ── Main ─────────────────────────────────────────────────────────────

const main = async () => {
  // Options CLI :
  //   --force          : ré-enrichit toutes les entrées, même déjà traitées
  //   --source <src>   : limite le traitement aux entrées d'une source donnée
  //                      ex. --source capitals:manual
  const args = process.argv.slice(2);
  const forceAll = args.includes("--force");
  const sourceIdx = args.indexOf("--source");
  const filterSource = sourceIdx !== -1 ? args[sourceIdx + 1] : null;

  if (!fs.existsSync(INDEX_FILE)) {
    log(`❌ index.json introuvable: ${INDEX_FILE}`);
    process.exit(1);
  }

  const index: Index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  const allEntries = Object.entries(index);
  const total = allEntries.length;

  // Options CLI :
  //   --force           : ré-enrichit tout, même déjà enrichi
  //   --source <src>    : limite aux entrées d'une source donnée (ex. capitals:manual)
  //   --since <date>    : ré-enrichit les entrées enrichies AVANT cette date ISO
  //                       (ex. --since 2026-01-01)
  const sinceIdx = args.indexOf("--since");
  const sinceDate = sinceIdx !== -1 ? new Date(args[sinceIdx + 1]) : undefined;

  // Filtrer les entrées à enrichir
  const toEnrich = allEntries.filter(([, e]) => {
    if (!e.wikidata_id) return false;
    if (filterSource && e.source !== filterSource) return false;
    if (forceAll) return true;
    return needsEnrichment(e, sinceDate);
  });
  const alreadyDone = total - toEnrich.length;

  log(`📖 Index chargé: ${total} entrées`);
  if (forceAll)
    log(
      `⚡ Mode --force : ré-enrichissement complet${filterSource ? ` (source: ${filterSource})` : ""}`,
    );
  if (sinceDate)
    log(
      `📅 Mode --since ${sinceDate.toISOString().slice(0, 10)} : ré-enrichit les entrées enrichies avant cette date`,
    );
  if (filterSource && !forceAll && !sinceDate)
    log(`🔍 Filtre source: "${filterSource}"`);
  if (alreadyDone > 0 && !forceAll && !sinceDate) {
    log(
      `⏭️  Reprise: ${alreadyDone} déjà enrichies, ${toEnrich.length} restantes`,
    );
  } else {
    log(`🌐 Enrichissement Wikidata: ${toEnrich.length} entrées à traiter...`);
  }

  const BATCH_SIZE = 50;
  let enriched = 0;
  let coordsRecovered = 0;
  let inceptionFound = 0;
  let culturesFound = 0;

  for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
    const batch = toEnrich.slice(i, i + BATCH_SIZE);
    const ids = batch.map(([, e]) => e.wikidata_id!);
    const enrichments = await batchFetchWikidata(ids);

    for (const [title, entry] of batch) {
      const enrichment = enrichments.get(entry.wikidata_id!);
      if (!enrichment) continue;

      const hadCoords = Boolean(entry.coordinates);

      // Appliquer — ne remplace pas les données déjà présentes
      if (!entry.coordinates && enrichment.coordinates)
        entry.coordinates = enrichment.coordinates;
      if (!entry.country && enrichment.country)
        entry.country = enrichment.country;
      if (!entry.country_qid && enrichment.country_qid)
        entry.country_qid = enrichment.country_qid;
      if (!entry.names && enrichment.names) entry.names = enrichment.names;
      if (!entry.native_label && enrichment.native_label)
        entry.native_label = enrichment.native_label;
      if (!entry.inception && enrichment.inception)
        entry.inception = enrichment.inception;
      if (!entry.dissolution && enrichment.dissolution)
        entry.dissolution = enrichment.dissolution;
      if (!entry.cultures && enrichment.cultures)
        entry.cultures = enrichment.cultures;
      if (!entry.site_type && enrichment.site_type)
        entry.site_type = enrichment.site_type;

      entry.wikidata_enriched_at = new Date().toISOString();
      if (!hadCoords && entry.coordinates) coordsRecovered++;
      if (entry.inception) inceptionFound++;
      if (entry.cultures?.length) culturesFound++;
      enriched++;
    }

    // Sauvegarde toutes les 50 entrées
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

    const progress = Math.min(i + BATCH_SIZE, toEnrich.length);
    const pct = Math.round((100 * progress) / toEnrich.length);
    log(
      `  [${pct}%] ${progress}/${toEnrich.length} — coords récupérées: ${coordsRecovered}, dates: ${inceptionFound}, cultures: ${culturesFound}`,
    );

    if (i + BATCH_SIZE < toEnrich.length) await delay(500);
  }

  // Résoudre les labels pays manquants (QIDs absents de COUNTRY_LABELS)
  const missingCountryQids = [
    ...new Set(
      Object.values(index)
        .filter((e) => e.country_qid && !e.country)
        .map((e) => e.country_qid!),
    ),
  ];

  if (missingCountryQids.length > 0) {
    log(`  Résolution de ${missingCountryQids.length} labels pays inconnus...`);
    const labelMap = await resolveEntityLabels(missingCountryQids);
    let resolved = 0;
    for (const entry of Object.values(index)) {
      if (entry.country_qid && !entry.country) {
        entry.country = labelMap.get(entry.country_qid);
        if (entry.country) resolved++;
      }
    }
    log(`  ${resolved} pays résolus`);
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  }

  // Stats finales
  const finalCoords = Object.values(index).filter((e) => e.coordinates).length;
  const finalCountry = Object.values(index).filter((e) => e.country).length;
  const finalInception = Object.values(index).filter((e) => e.inception).length;
  const finalCultures = Object.values(index).filter(
    (e) => e.cultures?.length,
  ).length;

  log("─".repeat(60));
  log(`✅ Enrichissement terminé`);
  log(`   Entrées enrichies  : ${enriched}`);
  log(
    `   Avec coordonnées   : ${finalCoords}/${total} (${Math.round((100 * finalCoords) / total)}%)`,
  );
  log(
    `   Avec pays          : ${finalCountry}/${total} (${Math.round((100 * finalCountry) / total)}%)`,
  );
  log(
    `   Avec date inception: ${finalInception}/${total} (${Math.round((100 * finalInception) / total)}%)`,
  );
  log(
    `   Avec cultures      : ${finalCultures}/${total} (${Math.round((100 * finalCultures) / total)}%)`,
  );
};

main().catch((error) => {
  log(`❌ Erreur fatale: ${error}`);
  process.exit(1);
});
