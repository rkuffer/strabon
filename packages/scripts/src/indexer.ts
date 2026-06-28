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
  return {
    title,
    wikidata_id: page.pageprops?.wikibase_item ?? null,
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
  "Q1048835", // political territorial entity
  "Q2221906", // geographic location
  "Q208511", // Roman fort
  "Q1986169", // Roman settlement
  "Q207694", // archaeological museum
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

  // 3. Stratégie A : P1366 (replaced by) — rarement renseigné mais le plus précis
  const replacedByQid =
    claims["P1366"]?.[0]?.mainsnak?.datavalue?.value?.id ?? null;

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
          console.log(`  ✓ Lien résolu: "${link}" → ${lQid}`);
          modernQid = lQid;
          modernTitle = link;
          break;
        } else {
          console.log(
            `  ⏭ Lien ignoré: "${link}" (QID: ${lQid ?? "??"}, coords: ${lCoord ? "oui" : "non"})`,
          );
        }
      }
    }
  }

  if (!modernQid) {
    console.log(`  ✗ ${wikidataId} — aucune ville moderne trouvée`);
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

// ── Routes ────────────────────────────────────────────────────────────────────

export const adminIndexRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/index — page formulaire
  app.get("/admin/index", async (_req, reply) => {
    return reply.view("admin/index/form", {
      title: "Indexation — Admin",
    });
  });

  // POST /admin/index/preview — preview des pages trouvées (avant import)
  app.post<{
    Body: { mode: "category" | "keyword" | "manual"; value: string };
  }>("/admin/index/preview", async (req, reply) => {
    const { mode, value } = req.body;
    if (!value?.trim())
      return reply.status(400).send({ error: "value required" });

    let titles: string[] = [];
    if (mode === "category") titles = await fetchCategoryPages(value.trim());
    if (mode === "keyword") titles = await fetchByKeyword(value.trim());
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
          const slug = finalTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "");
          finalId = `local_${slug}`;
        }

        await upsertSite({
          id: finalId,
          wikidata_id: finalId.startsWith("local_") ? undefined : finalId,
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
      } catch {
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

      const titles =
        mode === "category"
          ? await fetchCategoryPages(value)
          : await fetchByKeyword(value);

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
