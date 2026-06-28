// packages/server/src/routes/admin/indexer.ts
import type { FastifyPluginAsync } from "fastify";
import { getSql, upsertSite } from "@strabon/db";

// ── Helpers Wikipedia ────────────────────────────────────────────────────────

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const UA = "Strabon/1.0 (https://github.com/strabon)";

async function fetchWiki(params: Record<string, string>) {
  const url = `${WIKI_API}?${new URLSearchParams({ ...params, format: "json", origin: "*" })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  return res.json();
}

async function fetchCategoryPages(category: string): Promise<string[]> {
  const data = await fetchWiki({
    action: "query",
    list: "categorymembers",
    cmtitle: `Category:${category}`,
    cmlimit: "500",
    cmtype: "page",
  });
  return (data.query?.categorymembers ?? []).map((m: any) => m.title);
}

async function fetchByKeyword(keyword: string): Promise<string[]> {
  const data = await fetchWiki({
    action: "query",
    list: "search",
    srsearch: keyword,
    srnamespace: "0",
    srlimit: "50",
  });
  return (data.query?.search ?? []).map((r: any) => r.title);
}

async function fetchPageMeta(title: string) {
  // Tentative directe
  const data = await fetchWiki({
    action: "query",
    prop: "info|coordinates|description|pageprops",
    titles: title,
    inprop: "url",
    ppprop: "wikibase_item",
  });
  const pages = data.query?.pages ?? {};
  let page = Object.values(pages)[0] as any;

  // Si page introuvable, faire une recherche pour trouver le titre canonique
  // Utile quand l'utilisateur saisit un titre dans une autre langue (ex. "Beyrouth" → "Beirut")
  if (!page || page.missing) {
    const searchData = await fetchWiki({
      action: "query",
      list: "search",
      srsearch: title,
      srnamespace: "0",
      srlimit: "1",
    });
    const firstResult = searchData.query?.search?.[0];
    if (!firstResult) return null;

    // Refaire la requête avec le titre canonique trouvé
    const data2 = await fetchWiki({
      action: "query",
      prop: "info|coordinates|description|pageprops",
      titles: firstResult.title,
      inprop: "url",
      ppprop: "wikibase_item",
    });
    const pages2 = data2.query?.pages ?? {};
    page = Object.values(pages2)[0] as any;
    if (!page || page.missing) return null;

    // Utiliser le titre canonique Wikipedia EN
    title = firstResult.title;
  }

  const coord = page.coordinates?.[0];
  const wikidataId = page.pageprops?.wikibase_item ?? null;

  // Validation Wikidata : vérifier que c'est bien un site géographique
  if (wikidataId) {
    const valid = await isValidSiteQid(wikidataId, title);
    if (!valid) {
      return null;
    }
  }

  return {
    title,
    wikidata_id: wikidataId,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    lat: coord?.lat ?? null,
    lon: coord?.lon ?? null,
    description: page.description ?? null,
  };
}

// ── Résolution ville moderne via Wikidata ─────────────────────────────────────
// Si un QID Wikidata correspond à une entité historique (ville ancienne, site
// archéologique), on cherche la ville moderne correspondante pour utiliser
// son QID comme identifiant canonique du site dans Strabon.

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// QIDs Wikidata des types "entité historique" qui signalent qu'on doit
// chercher la ville moderne
const ANCIENT_INSTANCE_OF = new Set([
  "Q839954", // archaeological site
  "Q3947", // house (ancient building)
  "Q486972", // human settlement (générique)
  "Q1523921", // ancient city
  "Q1549591", // big city (ancient)
  "Q15661340", // ancient settlement
  "Q2065736", // ancient Greek city
  "Q2202509", // ancient Roman city  ← Aquae Flaviae, Bracara Augusta...
  "Q1048835", // political territorial entity
  "Q2221906", // geographic location
  "Q208511", // Roman fort
  "Q1986169", // Roman settlement
  "Q207694", // archaeological museum
  "Q3024240", // historical city
  "Q16970531", // former human settlement
  "Q15042365", // ancient Greek city in Asia Minor
  "Q15642541", // human-geographic territorial entity
]);

async function resolveModernCity(
  wikidataId: string,
  wikipediaTitle: string,
): Promise<{
  id: string;
  title: string;
  url: string;
  lat: number | null;
  lon: number | null;
  description: string | null;
} | null> {
  // 1. Récupérer l'entité Wikidata pour vérifier si c'est une entité historique
  const url = `${WIKIDATA_API}?${new URLSearchParams({
    action: "wbgetentities",
    ids: wikidataId,
    props: "claims|descriptions",
    languages: "en",
    format: "json",
    origin: "*",
  })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const data = await res.json();
  const entity = data.entities?.[wikidataId];
  if (!entity || entity.missing) return null;

  const claims = entity.claims ?? {};

  // 2. Vérifier si c'est une entité historique via P31 (instance of)
  const instanceOf = (claims["P31"] ?? [])
    .map((s: any) => s.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
  console.log(
    `  🔍 resolveModernCity(${wikidataId}) — P31: [${instanceOf.join(", ")}]`,
  );
  const isAncient = instanceOf.some((id: string) =>
    ANCIENT_INSTANCE_OF.has(id),
  );
  if (!isAncient) {
    console.log(
      `  ⏭ ${wikidataId} — pas une entité ancienne connue, pas de résolution`,
    );
    return null;
  }
  console.log(
    `  ✓ ${wikidataId} — entité ancienne détectée, recherche ville moderne...`,
  );

  // 3. Stratégie A : P1366 (replaced by) — suivi récursif de la chaîne
  // Byzance → Constantinople → Istanbul : on suit jusqu'au bout (max 5 sauts)
  let replacedByQid: string | null =
    claims["P1366"]?.[0]?.mainsnak?.datavalue?.value?.id ?? null;

  if (replacedByQid) {
    let currentQid = replacedByQid;
    let hops = 0;
    const MAX_HOPS = 5;

    while (hops < MAX_HOPS) {
      const nextUrl = `${WIKIDATA_API}?${new URLSearchParams({
        action: "wbgetentities",
        ids: currentQid,
        props: "claims",
        format: "json",
        origin: "*",
      })}`;
      const nextRes = await fetch(nextUrl, { headers: { "User-Agent": UA } });
      const nextData = await nextRes.json();
      const nextEntity = nextData.entities?.[currentQid];
      if (!nextEntity || nextEntity.missing) break;

      const nextReplaced =
        nextEntity.claims?.["P1366"]?.[0]?.mainsnak?.datavalue?.value?.id ??
        null;

      if (!nextReplaced) break; // fin de chaîne

      console.log(`  🔗 P1366 chaîne: ${currentQid} → ${nextReplaced}`);
      currentQid = nextReplaced;
      hops++;
    }

    replacedByQid = currentQid;
    if (hops > 0) {
      console.log(`  ✓ P1366 résolu en ${hops} saut(s) → ${replacedByQid}`);
    }
  }

  // 4. Stratégie B : lire l'intro Wikipedia pour trouver le lien vers la ville moderne
  //    "Aquae Flaviae is the ancient Roman city of [[Chaves, Portugal|Chaves]]"
  //    On cherche le premier lien Wikipedia interne dans la description de la page
  let modernQid = replacedByQid;
  let modernTitle: string | null = null;

  if (!modernQid) {
    console.log(
      `  🔍 Stratégie B — lecture intro Wikipedia "${wikipediaTitle}"...`,
    );
    // Fetch le premier paragraphe Wikipedia pour chercher un lien vers une ville actuelle
    const wikiIntro = await fetchWiki({
      action: "query",
      prop: "extracts|links",
      titles: wikipediaTitle,
      exintro: "1",
      exsentences: "3",
      plnamespace: "0",
      pllimit: "10",
      format: "json",
      origin: "*",
    });
    const pages = wikiIntro.query?.pages ?? {};
    const page = Object.values(pages)[0] as any;
    const links = (page?.links ?? []).map((l: any) => l.title) as string[];
    const intro = (page?.extract ?? "").toLowerCase();

    // Chercher dans les liens un qui ressemble à une ville moderne
    // Heuristique : lien mentionné dans l'intro + pas un article historique
    for (const link of links) {
      if (intro.includes(link.toLowerCase().split(",")[0].toLowerCase())) {
        // Vérifier que ce lien a un QID Wikidata et des coordonnées (= lieu réel habité)
        const linkMeta = await fetchWiki({
          action: "query",
          prop: "pageprops|coordinates",
          titles: link,
          ppprop: "wikibase_item",
          format: "json",
          origin: "*",
        });
        const lPages = linkMeta.query?.pages ?? {};
        const lPage = Object.values(lPages)[0] as any;
        const lQid = lPage?.pageprops?.wikibase_item;
        const lCoord = lPage?.coordinates?.[0];

        if (lQid && lCoord && link !== wikipediaTitle) {
          // Vérifier que c'est bien une ville/commune moderne — pas une région ou province
          const lWdData = await (async () => {
            const r = await fetch(
              `${WIKIDATA_API}?${new URLSearchParams({ action: "wbgetentities", ids: lQid, props: "claims", format: "json", origin: "*" })}`,
              { headers: { "User-Agent": UA } },
            );
            return r.json();
          })();
          const lEntity = lWdData.entities?.[lQid];
          const lInstanceOf = (lEntity?.claims?.["P31"] ?? [])
            .map((s: any) => s.mainsnak?.datavalue?.value?.id)
            .filter(Boolean) as string[];
          const isModernCity = lInstanceOf.some((id) =>
            MODERN_CITY_TYPES.has(id),
          );

          if (isModernCity) {
            console.log(
              `  ✓ Lien résolu: "${link}" → ${lQid} (P31: ${lInstanceOf[0]})`,
            );
            modernQid = lQid;
            modernTitle = link;
            break;
          } else {
            console.log(
              `  ⏭ Lien ignoré: "${link}" — P31 [${lInstanceOf.join(", ")}] n'est pas une ville moderne`,
            );
          }
        } else {
          console.log(
            `  ⏭ Lien ignoré: "${link}" (QID: ${lQid ?? "??"}, coords: ${lCoord ? "oui" : "non"})`,
          );
        }
      }
    }
  }

  if (!modernQid) {
    console.log(
      `  ⚑ ${wikidataId} — aucune ville moderne trouvée, indexation sous nom antique`,
    );
    return null;
  }

  // 5. Récupérer les infos complètes de la ville moderne depuis Wikidata
  const url2 = `${WIKIDATA_API}?${new URLSearchParams({
    action: "wbgetentities",
    ids: modernQid,
    props: "claims|labels|sitelinks|descriptions",
    languages: "en",
    format: "json",
    origin: "*",
  })}`;
  const res2 = await fetch(url2, { headers: { "User-Agent": UA } });
  const data2 = await res2.json();
  const modern = data2.entities?.[modernQid];
  if (!modern || modern.missing) return null;

  const enwikiTitle = modern.sitelinks?.enwiki?.title ?? modernTitle;
  if (!enwikiTitle) return null;

  const coordClaim = modern.claims?.["P625"]?.[0]?.mainsnak?.datavalue?.value;
  const lat = coordClaim?.latitude ?? null;
  const lon = coordClaim?.longitude ?? null;
  const label = modern.labels?.en?.value ?? enwikiTitle;

  console.log(
    `  📍 ${wikidataId} (${wikipediaTitle}) → ${modernQid} (${label})`,
  );

  return {
    id: modernQid,
    title: enwikiTitle,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(enwikiTitle.replace(/ /g, "_"))}`,
    lat,
    lon,
    description: modern.descriptions?.en?.value ?? null,
  };
}

// QIDs Wikidata des types correspondant à des villes/communes actuellement habitées.
// Utilisé pour valider qu'un lien Wikipedia résolu est bien une ville moderne
// et non une région, province, ou site historique.
const MODERN_CITY_TYPES = new Set([
  "Q515", // city
  "Q5119", // capital city
  "Q3957", // town
  "Q532", // village
  "Q486972", // human settlement
  "Q1549591", // big city
  "Q1637706", // city with 1M+ inhabitants
  "Q747074", // commune of Portugal
  "Q36784", // municipality of Portugal
  "Q13217644", // municipality of Portugal (type alternatif — Chaves, Coimbra, Porto...)
  "Q708676", // municipality of Spain (type alternatif)
  "Q2326765", // municipality of France (type alternatif)
  "Q2616791", // municipality of Spain
  "Q1907114", // municipality of France
  "Q15284", // municipality of Italy
  "Q21672098", // municipality of Turkey
  "Q15141321", // municipality of Lebanon
  "Q3024240", // historical city (encore habitée)
  "Q1093829", // city in the United States
  "Q7930989", // city/town
]);

// ── Validation Wikidata d'un site indexable ───────────────────────────────────
// Un site est indexable si son P31 (instance of) correspond à un lieu physique
// (ville ancienne, site archéologique, commune moderne...).
// Rejette les articles de liste, régions, provinces, concepts abstraits, etc.

const VALID_SITE_TYPES = new Set([
  // Lieux anciens
  ...ANCIENT_INSTANCE_OF,
  // Villes/communes modernes
  ...MODERN_CITY_TYPES,
  // Types supplémentaires non couverts par les deux sets
  "Q618123", // geographical feature
  "Q15661340", // ancient settlement
  "Q1081138", // archaeological culture
  "Q839954", // archaeological site (déjà dans ANCIENT mais explicite ici)
  "Q1248784", // airfield / aéroport (sites modernes)
  "Q1307214", // populated place
  "Q5765779", // hamlet
  "Q56436498", // ancient city-state
  "Q7015028", // Phoenician city
]);

// QIDs P31 explicitement rejetés (régions, listes, concepts)
const INVALID_SITE_TYPES = new Set([
  "Q13406463", // Wikimedia list article
  "Q17329259", // Wikimedia article about a real-world entity
  "Q4167836", // Wikimedia category
  "Q4167410", // Wikimedia disambiguation page
  "Q82794", // geographic region
  "Q3329412", // geographical area
  "Q182547", // historical region
  "Q1799794", // historical territory
  "Q6256", // country
  "Q3624078", // sovereign state
  "Q7275", // state (polity)
  "Q10864048", // first-level administrative country subdivision
  "Q13220204", // county
  "Q2074737", // maritime region
  "Q3775649", // region of Portugal
  "Q20963720", // intermunicipal community of Portugal
]);

async function isValidSiteQid(
  wikidataId: string,
  title: string,
): Promise<boolean> {
  if (!wikidataId) return false;
  try {
    const url = `${WIKIDATA_API}?${new URLSearchParams({
      action: "wbgetentities",
      ids: wikidataId,
      props: "claims",
      format: "json",
      origin: "*",
    })}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    if (!entity || entity.missing) {
      console.log(
        `  🚫 "${title}" (${wikidataId}) — entité Wikidata introuvable`,
      );
      return false;
    }

    const instanceOf = (entity.claims?.["P31"] ?? [])
      .map((s: any) => s.mainsnak?.datavalue?.value?.id)
      .filter(Boolean) as string[];

    const p31str = instanceOf.length ? instanceOf.join(", ") : "aucun";

    // Rejet explicite en priorité
    const invalidMatch = instanceOf.find((id) => INVALID_SITE_TYPES.has(id));
    if (invalidMatch) {
      console.log(
        `  🚫 "${title}" (${wikidataId}) — rejeté, P31 contient ${invalidMatch} [${p31str}]`,
      );
      return false;
    }

    // Acceptation si au moins un type valide
    const validMatch = instanceOf.find((id) => VALID_SITE_TYPES.has(id));
    if (validMatch) {
      console.log(
        `  ✅ "${title}" (${wikidataId}) — accepté, P31: ${validMatch} [${p31str}]`,
      );
      return true;
    }

    // Fallback : coordonnées P625
    const hasCoords = (entity.claims?.["P625"] ?? []).length > 0;
    if (hasCoords) {
      console.log(
        `  ✅ "${title}" (${wikidataId}) — accepté via coords (P31 inconnu: [${p31str}])`,
      );
    } else {
      console.log(
        `  🚫 "${title}" (${wikidataId}) — rejeté, P31 inconnu et pas de coords [${p31str}]`,
      );
    }
    return hasCoords;
  } catch (err: any) {
    console.log(
      `  ⚠️ "${title}" (${wikidataId}) — erreur Wikidata, laissé passer: ${err.message}`,
    );
    return true;
  }
}

// ── Filtre des titres non-indexables ─────────────────────────────────────────
// Exclut les pages qui ne sont pas des sites géographiques individuels :
// articles de liste, articles de catégorie, articles d'homonymie, etc.

const TITLE_EXCLUDE_PREFIXES = [
  "List of",
  "Lists of",
  "History of",
  "Geography of",
  "Culture of",
  "Economy of",
  "Politics of",
  "Religion in",
  "Timeline of",
  "Index of",
  "Outline of",
  "Category:",
  "Archaeology of",
  "Architecture of",
  "Cities in",
];

const TITLE_EXCLUDE_PATTERNS = [
  / in [A-Z]/, // "Roman cities in Portugal", "Ancient sites in Syria"
  /^History /,
  /^List /,
  / \(disambiguation\)$/,
  / \(region /, // "Tripolis (region of Phoenicia)"
  / \(province /, // "Gallia (province of Rome)"
  / letters? /i, // "Amarna letters localities and rulers"
  /localities and/i, // "Amarna letters localities and rulers"
  / rulers?$/i, // titres se terminant par "rulers"
  /^Ancient .+ letters/i,
];

function isIndexableTitle(title: string): boolean {
  for (const prefix of TITLE_EXCLUDE_PREFIXES) {
    if (title.startsWith(prefix)) return false;
  }
  for (const pattern of TITLE_EXCLUDE_PATTERNS) {
    if (pattern.test(title)) return false;
  }
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const adminIndexRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/index — page formulaire
  app.get("/admin/index", async (_req, reply) => {
    return reply.view("admin/index/form", {
      title: "Indexation — Admin",
    });
  });

  // GET /admin/index/search-wikidata?q=... — recherche interactive Wikidata pour ajout manuel
  app.get<{
    Querystring: { q: string };
  }>("/admin/index/search-wikidata", async (req, reply) => {
    const { q } = req.query;
    if (!q?.trim()) return reply.status(400).send({ error: "q required" });

    const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
      action: "wbsearchentities",
      search: q.trim(),
      language: "en",
      type: "item",
      limit: "10",
      format: "json",
      origin: "*",
    })}`;

    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return reply.status(502).send({ error: "Wikidata API error" });
    const data = await res.json();

    const seen = new Set<string>();
    const candidates = [];
    for (const item of data.search ?? []) {
      const qid = item.id;
      if (seen.has(qid)) continue;
      seen.add(qid);

      const wpData = await fetchWiki({
        action: "query",
        prop: "info|coordinates|description",
        titles: item.label,
        inprop: "url",
      }).catch(() => null);

      const wpPages = wpData?.query?.pages ?? {};
      const wpPage = Object.values(wpPages)[0] as any;
      const coord = wpPage?.coordinates?.[0] ?? null;
      const wpTitle =
        !wpPage?.missing && wpPage?.title ? wpPage.title : item.label;
      const wpUrl = wpTitle
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wpTitle.replace(/ /g, "_"))}`
        : null;

      candidates.push({
        qid,
        label: item.label,
        description: item.description ?? wpPage?.description ?? null,
        url: wpUrl,
        lat: coord?.lat ?? null,
        lon: coord?.lon ?? null,
        has_coords: !!(coord?.lat && coord?.lon),
        wikidata_id: qid,
        title: wpTitle,
      });
    }

    const sql = getSql();
    const existingQids = new Set(
      (
        await sql`SELECT id FROM sites WHERE id = ANY(${candidates.map((c) => c.qid)})`
      ).map((r: any) => r.id),
    );

    console.log(
      `[search-wikidata] "${q}" → ${candidates.length} candidats: ${candidates.map((c) => `${c.label} (${c.qid})`).join(", ")}`,
    );

    const result = candidates.map((c) => ({
      ...c,
      already_exists: existingQids.has(c.qid),
    }));

    result.forEach((c) => {
      if (c.already_exists)
        console.log(
          `[search-wikidata]   ⊘ ${c.label} (${c.qid}) — déjà en base`,
        );
      else
        console.log(
          `[search-wikidata]   ○ ${c.label} (${c.qid}) — coords: ${c.has_coords ? "✓" : "✗"}`,
        );
    });

    return reply.send({ candidates: result });
  });

  // POST /admin/index/preview — preview des pages trouvées (avant import)
  app.post<{
    Body: { mode: "category" | "keyword" | "manual"; value: string };
  }>("/admin/index/preview", async (req, reply) => {
    const { mode, value } = req.body;
    if (!value?.trim())
      return reply.status(400).send({ error: "value required" });

    let titles: string[] = [];
    if (mode === "category")
      titles = (await fetchCategoryPages(value.trim())).filter(
        isIndexableTitle,
      );
    if (mode === "keyword")
      titles = (await fetchByKeyword(value.trim())).filter(isIndexableTitle);
    if (mode === "manual") titles = [value.trim()];

    // Récupérer les métadonnées en batch de 10 (limiter les requêtes)
    const metas = [];
    for (let i = 0; i < Math.min(titles.length, 100); i++) {
      const meta = await fetchPageMeta(titles[i]);
      if (meta) metas.push(meta);
    }

    // Vérifier lesquels sont déjà en base
    const sql = getSql();
    const existingUrls = new Set(
      (await sql`SELECT wikipedia_page_en_url FROM sites`).map(
        (r: any) => r.wikipedia_page_en_url,
      ),
    );

    const preview = metas.map((m) => ({
      ...m,
      already_exists: existingUrls.has(m.url),
    }));

    return reply.send({ titles: preview, total: titles.length });
  });

  // POST /admin/index/import — import confirmé après preview
  app.post<{
    Body: {
      sites: Array<{
        title: string;
        url: string;
        wikidata_id?: string;
        lat?: number;
        lon?: number;
        description?: string;
      }>;
    };
  }>("/admin/index/import", async (req, reply) => {
    const { sites } = req.body;
    if (!sites?.length)
      return reply.status(400).send({ error: "sites required" });

    let imported = 0,
      errors = 0;
    for (const site of sites) {
      try {
        // Tenter de résoudre vers la ville moderne si l'entité est historique
        let finalId = site.wikidata_id;
        let finalTitle = site.title;
        let finalUrl = site.url;
        let finalLat = site.lat;
        let finalLon = site.lon;
        let finalDesc = site.description;
        let historicalTitle: string | null = null;

        if (site.wikidata_id) {
          const modern = await resolveModernCity(site.wikidata_id, site.title);
          if (modern) {
            historicalTitle = site.title; // on mémorise le nom antique
            finalId = modern.id;
            finalTitle = modern.title;
            finalUrl = modern.url;
            finalLat = modern.lat ?? site.lat;
            finalLon = modern.lon ?? site.lon;
            finalDesc = modern.description ?? site.description;
          }
        }

        if (!finalId) {
          console.warn(`[import] rejet "${finalTitle}" — pas de QID Wikidata`);
          errors++;
          continue;
        }

        await upsertSite({
          id: finalId,
          wikidata_id: finalId,
          title_en: finalTitle,
          wikipedia_page_en_url: finalUrl,
          source: "admin:manual",
          lat: finalLat ?? undefined,
          lon: finalLon ?? undefined,
          meta: {
            description: finalDesc,
            historical_title: historicalTitle, // nom antique conservé pour le LLM
          },
        });
        imported++;
      } catch (err: any) {
        console.error(`❌ Import error for "${site.title}":`, err.message);
        errors++;
      }
    }

    return reply.send({ imported, errors });
  });

  // GET /admin/index/stream?mode=category&value=... — SSE pour indexation batch
  app.get<{
    Querystring: { mode: "category" | "keyword"; value: string };
  }>("/admin/index/stream", async (req, reply) => {
    const { mode, value } = req.query;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders?.();

    const send = (event: string, data: object) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send("start", { message: `Démarrage indexation ${mode}: ${value}` });

      const titles = (
        mode === "category"
          ? await fetchCategoryPages(value)
          : await fetchByKeyword(value)
      ).filter(isIndexableTitle);

      send("total", { total: titles.length });

      const sql = getSql();
      let added = 0,
        skipped = 0,
        errors = 0;

      for (const title of titles) {
        try {
          // Vérifier si déjà indexé
          const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
          const existing =
            await sql`SELECT id FROM sites WHERE wikipedia_page_en_url = ${url} LIMIT 1`;
          if (existing.length) {
            skipped++;
            send("skip", { title, reason: "already_exists" });
            continue;
          }

          const meta = await fetchPageMeta(title);
          if (!meta) {
            skipped++;
            send("skip", { title, reason: "no_meta" });
            continue;
          }

          // Tenter de résoudre vers la ville moderne si l'entité est historique
          let finalId = meta.wikidata_id;
          let finalTitle = title;
          let finalUrl = meta.url;
          let finalLat = meta.lat;
          let finalLon = meta.lon;
          let finalDesc = meta.description;
          let historicalTitle: string | null = null;

          if (meta.wikidata_id) {
            const modern = await resolveModernCity(meta.wikidata_id, title);
            if (modern) {
              historicalTitle = title;
              finalId = modern.id;
              finalTitle = modern.title;
              finalUrl = modern.url;
              finalLat = modern.lat ?? meta.lat;
              finalLon = modern.lon ?? meta.lon;
              finalDesc = modern.description ?? meta.description;
              send("resolve", {
                original: title,
                modern: finalTitle,
                id: finalId,
              });
            }
          }

          const slug = finalTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "");
          if (!finalId) finalId = `local_${slug}`;

          await upsertSite({
            id: finalId,
            wikidata_id: finalId.startsWith("local_") ? undefined : finalId,
            title_en: finalTitle,
            wikipedia_page_en_url: finalUrl,
            source: `admin:${mode}:${value}`,
            lat: finalLat ?? undefined,
            lon: finalLon ?? undefined,
            meta: {
              description: finalDesc,
              historical_title: historicalTitle,
            },
          });
          added++;
          send("add", { title, id, has_coords: !!(meta.lat && meta.lon) });

          // Throttle minimal
          await new Promise((r) => setTimeout(r, 200));
        } catch (err: any) {
          errors++;
          send("error", { title, message: err.message });
        }
      }

      send("done", { added, skipped, errors, total: titles.length });
    } catch (err: any) {
      send("fatal", { message: err.message });
    } finally {
      reply.raw.end();
    }
  });
};
