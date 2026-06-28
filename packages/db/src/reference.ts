import { getSql } from "./client.js";
import type { Polity, Culture, SiteTimeline } from "@strabon/shared";

// ── Polities ──────────────────────────────────────────────────────────────────

export async function getAllPolities(): Promise<Polity[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT wikidata_id, name, type, color, wikipedia_url
    FROM polities
    ORDER BY name
  `;
  return rows as unknown as Polity[];
}

export async function upsertPolity(polity: Polity): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO polities (wikidata_id, name, type, color, wikipedia_url)
    VALUES (${polity.wikidata_id}, ${polity.name}, ${polity.type ?? null}, ${polity.color ?? null}, ${polity.wikipedia_url ?? null})
    ON CONFLICT (wikidata_id) DO UPDATE SET
      name          = EXCLUDED.name,
      type          = COALESCE(EXCLUDED.type, polities.type),
      color         = COALESCE(EXCLUDED.color, polities.color),
      wikipedia_url = COALESCE(EXCLUDED.wikipedia_url, polities.wikipedia_url)
  `;
}

// ── Cultures ──────────────────────────────────────────────────────────────────

export async function getAllCultures(): Promise<Culture[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT wikidata_id, name, type, color, wikipedia_url
    FROM cultures
    ORDER BY name
  `;
  return rows as unknown as Culture[];
}

export async function upsertCulture(culture: Culture): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO cultures (wikidata_id, name, type, color, wikipedia_url)
    VALUES (${culture.wikidata_id}, ${culture.name}, ${culture.type ?? null}, ${culture.color ?? null}, ${culture.wikipedia_url ?? null})
    ON CONFLICT (wikidata_id) DO UPDATE SET
      name          = EXCLUDED.name,
      type          = COALESCE(EXCLUDED.type, cultures.type),
      color         = COALESCE(EXCLUDED.color, cultures.color),
      wikipedia_url = COALESCE(EXCLUDED.wikipedia_url, cultures.wikipedia_url)
  `;
}

// ── Synchronisation automatique des référentiels ──────────────────────────────
// Appelée après toute écriture de timeline.
// Règles :
//   - ON CONFLICT DO NOTHING préserve les couleurs déjà assignées manuellement
//   - Les QIDs commençant par "local_" sont exclus : ils restent dans les
//     timelines pour la frise mais ne participent pas aux hulls ni aux référentiels
//   - SEULES les entrées fiables alimentent les tables de référence :
//       • QID au format Wikidata canonique (^Q\d+$)
//       • confidence === "high" (= attesté depuis une source, pas inféré)
//     Une entrée inférée (structural inference, confidence low/medium) peut porter
//     un QID approximatif ou placeholder ; on l'accepte dans la timeline du site
//     mais JAMAIS dans les référentiels partagés, qu'elle polluerait silencieusement.

// Garde une entrée seulement si son QID est un vrai QID et l'entrée est attestée.
function isReliableRefEntry(entry: any): boolean {
  const v = entry?.value;
  return (
    !!v?.wikidata &&
    !!v?.name &&
    /^Q\d+$/.test(v.wikidata) &&
    entry?.confidence === "high"
  );
}

export async function syncReferentialsFromTimeline(
  timeline: SiteTimeline,
): Promise<{ polities: number; cultures: number }> {
  const sql = getSql();

  // ── Polities ──────────────────────────────────────────────────────────────
  const polityMap = new Map<string, string>(); // wikidata_id → name
  for (const entry of timeline.polity?.entries ?? []) {
    if (!isReliableRefEntry(entry)) continue;
    const v = entry.value as any;
    polityMap.set(v.wikidata, v.name);
  }

  let politiesInserted = 0;
  for (const [wikidata_id, name] of polityMap) {
    const r = await sql`
      INSERT INTO polities (wikidata_id, name)
      VALUES (${wikidata_id}, ${name})
      ON CONFLICT (wikidata_id) DO NOTHING
    `;
    if (r.count > 0) politiesInserted++;
  }

  // ── Cultures ──────────────────────────────────────────────────────────────
  const cultureMap = new Map<string, string>(); // wikidata_id → name
  for (const entry of timeline.culture?.entries ?? []) {
    if (!isReliableRefEntry(entry)) continue;
    const v = entry.value as any;
    cultureMap.set(v.wikidata, v.name);
  }

  let culturesInserted = 0;
  for (const [wikidata_id, name] of cultureMap) {
    const r = await sql`
      INSERT INTO cultures (wikidata_id, name)
      VALUES (${wikidata_id}, ${name})
      ON CONFLICT (wikidata_id) DO NOTHING
    `;
    if (r.count > 0) culturesInserted++;
  }

  return { polities: politiesInserted, cultures: culturesInserted };
}
