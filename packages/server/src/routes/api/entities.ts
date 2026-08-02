// routes/api/entities.ts
// =============================================================================
// Fiche d'une entité citée par une timeline — sert la modale ouverte au clic sur
// un segment (piste polity / culture / religion / language).
//
// DEUX SOURCES, assemblées ici :
//   1. NOTRE référentiel (wikidata_entities) — bornes, famille, rang, usage.
//      Peut être absent : une timeline peut citer un QID jamais ingéré. Ce n'est
//      pas une erreur, la modale reste utile (liens + libellé de l'entrée).
//   2. WIKIDATA — les SITELINKS, seul moyen d'obtenir une URL Wikipédia : le
//      référentiel ne stocke aucune URL d'article pour les entités (contrairement
//      aux sites, qui ont wikipedia_page_en_url).
//
// L'appel Wikidata passe par wikiFetchJson (throttle global partagé, cf. la
// leçon des HTTP 429 en série) et JAMAIS directement depuis le navigateur : on
// garde un seul point d'étranglement pour tout le trafic Wikimedia.
//
// Le lien Wikidata, lui, ne dépend que du QID — il est donc TOUJOURS servi, même
// quand l'entité est inconnue du référentiel et que Wikidata est injoignable.
// =============================================================================

import type { FastifyPluginAsync } from "fastify";
import { getEntityDetail } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";

/** Langues d'article proposées, dans l'ordre de préférence d'affichage. */
const WIKI_LANGS = ["en", "fr"] as const;

type WikiLinks = { lang: string; title: string; url: string }[];

// Cache mémoire : une entité très citée (Roman Empire, 206 entrées) serait
// autrement re-résolue à chaque clic. Pas de TTL — les sitelinks d'une entité
// historique ne bougent pas à l'échelle d'une session de curation ; le cache
// meurt avec le process.
const linksCache = new Map<string, WikiLinks>();

async function fetchWikipediaLinks(qid: string): Promise<WikiLinks> {
  const cached = linksCache.get(qid);
  if (cached) return cached;

  const sites = WIKI_LANGS.map((l) => `${l}wiki`).join("|");
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}` +
    `&props=sitelinks/urls&sitefilter=${sites}&format=json&formatversion=2`;

  const data = await wikiFetchJson(url);
  const sitelinks = data?.entities?.[qid]?.sitelinks ?? {};

  const links: WikiLinks = [];
  for (const lang of WIKI_LANGS) {
    const sl = sitelinks[`${lang}wiki`];
    if (sl?.url) links.push({ lang, title: sl.title ?? qid, url: sl.url });
  }

  linksCache.set(qid, links);
  return links;
}

export const apiEntitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { qid: string } }>("/entities/:qid", async (req, reply) => {
    const qid = req.params.qid?.trim();

    // Garde-fou de forme : la route est publique et le QID part vers Wikidata.
    if (!/^Q\d+$/.test(qid ?? "")) {
      return reply.code(400).send({ error: "invalid qid" });
    }

    const entity = await getEntityDetail(qid);

    // Wikidata peut être lent ou indisponible : son échec ne doit pas priver la
    // modale de ce que nous savons déjà. On dégrade sur une liste vide.
    let wikipedia: WikiLinks = [];
    try {
      wikipedia = await fetchWikipediaLinks(qid);
    } catch (err) {
      req.log.warn({ err, qid }, "wikipedia sitelinks fetch failed");
    }

    return reply.send({
      qid,
      in_referential: entity !== null,
      entity,
      wikidata_url: `https://www.wikidata.org/wiki/${qid}`,
      wikipedia,
    });
  });
};
