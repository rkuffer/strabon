import { getSql } from "./client.js";
import type { BoundsConflict, EntityBounds } from "@strabon/shared";

/** Référentiel des bornes, chargé une fois par run d'extraction. */
export async function loadEntityBounds(): Promise<Map<string, EntityBounds>> {
  const sql = getSql();
  const rows = await sql`
    SELECT qid, label_en, inception, inception_precision,
           dissolution, dissolution_precision
    FROM wikidata_entities
    WHERE inception IS NOT NULL OR dissolution IS NOT NULL
  `;
  return new Map(
    rows.map((r: any) => [
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
}

/**
 * Enregistre les conflits d'un site. REMPLACE les précédents : une ré-extraction
 * qui corrige une entrée doit faire DISPARAÎTRE son conflit, pas l'empiler. La
 * table est un état courant, pas un journal.
 *
 * Seuls les `incompatible` sont persistés — ce sont les seuls qu'un humain doit
 * arbitrer. `close` et `shorten` sont appliqués et n'appellent aucune décision.
 */
export async function recordBoundsConflicts(
  siteId: string,
  conflicts: BoundsConflict[],
): Promise<number> {
  const sql = getSql();
  const hard = conflicts.filter((c) => c.action === "incompatible");

  await sql`DELETE FROM bounds_conflicts WHERE site_id = ${siteId}`;
  if (!hard.length) return 0;

  for (const c of hard) {
    await sql`
      INSERT INTO bounds_conflicts (
        site_id, track, entity_qid, entity_label,
        entry_from, entry_to, entity_inception, entity_dissolution, detail
      ) VALUES (
        ${siteId}, ${c.track}, ${c.entity_qid}, ${c.entity_label},
        ${c.entry_from}, ${c.entry_to},
        ${c.entity_inception}, ${c.entity_dissolution}, ${c.detail}
      )
    `;
  }
  return hard.length;
}
