// =============================================================================
// entity-bounds-sync.ts — Propagation des bornes après enrichissement du référentiel
//
// LE PROBLÈME QUE CE FICHIER RÉSOUT
// ---------------------------------
// Résoudre un gap fait DEUX choses, et la seconde était invisible :
//
//   1. Elle ajoute une entité au référentiel — qui y entrait SANS BORNES, donc
//      hors de portée du seul garde déterministe qu'on ait.
//
//   2. `backfillSites` injecte le QID dans les entrées qui ne portaient jusque-là
//      qu'un NOM. Ces entrées deviennent BORNABLES POUR LA PREMIÈRE FOIS — et
//      personne ne les bornait. Une entrée « Merovingian » qui vient de recevoir
//      son QID gardait sa queue infinie jusqu'en 1990.
//
// Enrichir le référentiel CRÉE donc du travail de bornes. Ce fichier le fait.
// =============================================================================

import type { Sql } from "postgres";
import {
  applyEntityBounds,
  buildBoundsQuery,
  parseBoundsRows,
  type EntityBounds,
  type SiteTimeline,
} from "@strabon/shared";
import { recordBoundsConflicts } from "./bounds.js";

const WDQS = "https://query.wikidata.org/sparql";
const USER_AGENT = "Strabon/1.0 (historical atlas; github.com/rkuffer/strabon)";

/**
 * Récupère les bornes d'un petit lot de QID et les écrit dans wikidata_entities.
 * Prévu pour la résolution d'un gap (1 à quelques QID), pas pour le batch global
 * — celui-là reste le script, avec son retry et son dry-run.
 */
export async function fetchAndStoreBounds(
  sql: Sql<any>,
  qids: string[],
): Promise<number> {
  if (!qids.length) return 0;

  const res = await fetch(WDQS, {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    body: buildBoundsQuery(qids),
  });

  if (!res.ok) {
    console.warn(`[bounds] SPARQL ${res.status} for ${qids.join(",")}`);
    return 0;
  }

  const json = (await res.json()) as any;
  const bounds = parseBoundsRows(json.results.bindings);

  let written = 0;
  for (const b of bounds.values()) {
    await sql`
      UPDATE wikidata_entities SET
        inception             = ${b.inception},
        inception_precision   = ${b.inception_precision},
        dissolution           = ${b.dissolution},
        dissolution_precision = ${b.dissolution_precision},
        bounds_source         = 'sparql',
        bounds_confirmed      = FALSE,
        bounds_updated_at     = now()
      WHERE qid = ${b.qid}
    `;
    written++;
  }

  return written;
}

/**
 * Rejoue les bornes sur une liste de sites. Idempotent : applyEntityBounds ne
 * fait que fermer et raccourcir, donc un second passage ne trouve rien à faire.
 *
 * À appeler après TOUTE modification du référentiel qui touche ces sites.
 */
export async function reapplyBoundsToSites(
  sql: Sql<any>,
  siteIds: string[],
): Promise<{ sitesChanged: number; conflicts: number }> {
  if (!siteIds.length) return { sitesChanged: 0, conflicts: 0 };

  const boundsRows = await sql`
    SELECT qid, label_en, inception, inception_precision,
           dissolution, dissolution_precision
    FROM wikidata_entities
    WHERE inception IS NOT NULL OR dissolution IS NOT NULL
  `;

  const bounds = new Map<string, EntityBounds>(
    boundsRows.map((r: any) => [
      r.qid,
      {
        label: r.label_en,
        inception: r.inception,
        inception_precision: r.inception_precision,
        dissolution: r.dissolution,
        dissolution_precision: r.dissolution_precision,
      },
    ]),
  );

  const sites = await sql`
    SELECT id, timeline FROM sites
    WHERE id = ANY(${siteIds}::TEXT[]) AND timeline IS NOT NULL
  `;

  let sitesChanged = 0;
  let conflictCount = 0;

  for (const site of sites as any[]) {
    const { timeline, conflicts } = applyEntityBounds(
      site.timeline as SiteTimeline,
      bounds,
    );

    const applied = conflicts.filter((c) => c.action !== "incompatible");
    if (applied.length) {
      await sql`
        UPDATE sites SET timeline = ${sql.json(timeline as any)}
        WHERE id = ${site.id}
      `;
      sitesChanged++;
    }

    conflictCount += await recordBoundsConflicts(site.id, conflicts);
  }

  return { sitesChanged, conflicts: conflictCount };
}

/**
 * Le geste complet, après qu'une entité est entrée au référentiel :
 * ses bornes arrivent, puis les sites qui la mentionnent sont rebornés.
 */
export async function syncBoundsForNewEntity(
  sql: Sql<any>,
  qid: string,
  siteIds: string[],
): Promise<{ bounded: boolean; sitesChanged: number; conflicts: number }> {
  const written = await fetchAndStoreBounds(sql, [qid]);
  const { sitesChanged, conflicts } = await reapplyBoundsToSites(sql, siteIds);
  return { bounded: written > 0, sitesChanged, conflicts };
}
