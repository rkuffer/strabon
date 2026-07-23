// =============================================================================
// build-culture-attributions.ts
// -----------------------------------------------------------------------------
// Alimente `site_attributions` depuis la propriété Wikidata P2596 ("culture").
//
// Principe : pour chaque culture du référentiel, Wikidata sait déjà quels sites
// lui sont rattachés. On ne demande donc plus au LLM de le redécouvrir article
// par article — on lit l'attribution à la source, gratuitement, y compris pour
// des sites jamais extraits (L0).
//
// Ne touche QUE `site_attributions`. Les timelines produites par extraction ne
// sont jamais modifiées : les deux sources coexistent avec des provenances
// distinctes, et leur divergence est un signal de curation, pas un conflit.
//
// Idempotent : re-jouable, met à jour last_seen_at sur les attributions déjà
// connues. Les attributions disparues côté Wikidata ne sont PAS supprimées
// (on ne détruit pas un fait sur la foi d'une absence ponctuelle) — elles se
// repèrent à un last_seen_at qui cesse d'avancer.
//
// Usage :
//   DATABASE_URL=... npx -y tsx packages/scripts/src/build-culture-attributions.ts --dry-run
//   DATABASE_URL=... npx -y tsx packages/scripts/src/build-culture-attributions.ts
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const SOURCE = "wikidata-p2596";

// Petit à dessein : une culture prolifique (Rome ~2300 sites) peut dominer un
// lot, et WDQS coupe à 60 s. Mesuré : 12 cultures dont Rome → 1 s, 2942 lignes.
const BATCH_SIZE = 12;

function qidFromUri(uri: string): string {
  return uri.replace(/^.*\/entity\//, "");
}

/** Sites géolocalisés rattachés à ces cultures par P2596, groupés par culture. */
async function fetchAttributions(
  cultureQids: string[],
): Promise<Map<string, Set<string>>> {
  const values = cultureQids.map((q) => `wd:${q}`).join(" ");
  const query = `
    SELECT ?c ?site WHERE {
      VALUES ?c { ${values} }
      ?site wdt:P2596 ?c ;
            wdt:P625 ?coord .
    }`;
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const data = await wikiFetchJson(url);

  const out = new Map<string, Set<string>>();
  for (const b of data?.results?.bindings ?? []) {
    const c = qidFromUri(b.c.value);
    const site = qidFromUri(b.site.value);
    if (!out.has(c)) out.set(c, new Set());
    out.get(c)!.add(site);
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sql = getSql();

  const cultures = await sql<
    {
      qid: string;
      label: string;
      inception: number | null;
      dissolution: number | null;
    }[]
  >`
    SELECT qid, label_en AS label, inception, dissolution
    FROM wikidata_entities
    WHERE kind = 'culture'
    ORDER BY label_en
  `;
  console.log(
    `Référentiel culture : ${cultures.length} entités${dryRun ? "  [DRY RUN]" : ""}\n`,
  );

  let totalFound = 0; // rattachements vus chez Wikidata
  let totalMatched = 0; // ... dont le site est chez nous
  let totalWritten = 0;
  let unbounded = 0; // écrits sans bornes → rendus à toute époque
  const unboundedCultures: string[] = [];
  const perCulture: { label: string; matched: number; bounded: boolean }[] = [];

  for (let i = 0; i < cultures.length; i += BATCH_SIZE) {
    const batch = cultures.slice(i, i + BATCH_SIZE);
    process.stderr.write(
      `\r  Wikidata ${Math.min(i + BATCH_SIZE, cultures.length)}/${cultures.length}…`,
    );

    let found: Map<string, Set<string>>;
    try {
      found = await fetchAttributions(batch.map((c) => c.qid));
    } catch (err: any) {
      console.error(
        `\n  ⚠ lot ${batch.map((b) => b.qid).join(",")} échoué : ${err?.message}`,
      );
      continue;
    }

    for (const culture of batch) {
      const siteQids = [...(found.get(culture.qid) ?? [])];
      if (!siteQids.length) continue;
      totalFound += siteQids.length;

      // Ne garder que les sites que nous détenons. Être dans `sites` implique
      // déjà d'avoir passé le filtre place_classes au tuilage : inutile de
      // re-vérifier le périmètre ici.
      const known = await sql<{ id: string }[]>`
        SELECT id FROM sites WHERE wikidata_id = ANY(${siteQids})
      `;
      if (!known.length) continue;
      totalMatched += known.length;

      const hasBounds = culture.inception != null || culture.dissolution != null;
      if (!hasBounds) {
        unbounded += known.length;
        unboundedCultures.push(culture.label);
      }
      perCulture.push({
        label: culture.label,
        matched: known.length,
        bounded: hasBounds,
      });

      if (dryRun) continue;

      const rows = known.map((k) => ({
        site_id: k.id,
        kind: "culture",
        entity_qid: culture.qid,
        source: SOURCE,
        from_year: culture.inception,
        to_year: culture.dissolution,
      }));

      // Bornes rafraîchies à chaque passage : si la passe de bornes enrichit
      // l'entité plus tard, une simple re-exécution propage la correction.
      await sql`
        INSERT INTO site_attributions ${sql(
          rows,
          "site_id",
          "kind",
          "entity_qid",
          "source",
          "from_year",
          "to_year",
        )}
        ON CONFLICT (site_id, kind, entity_qid, source) DO UPDATE SET
          from_year    = EXCLUDED.from_year,
          to_year      = EXCLUDED.to_year,
          last_seen_at = now()
      `;
      totalWritten += rows.length;
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  perCulture.sort((a, b) => b.matched - a.matched);
  console.log("Rattachements retenus par culture (top 30) :");
  for (const c of perCulture.slice(0, 30)) {
    console.log(
      `  ${c.label.slice(0, 34).padEnd(35)} ${String(c.matched).padStart(5)}` +
        (c.bounded ? "" : "   ⚠ sans bornes"),
    );
  }

  console.log(`
──────────────────────────────────────────────────────────
  rattachements vus chez Wikidata     ${totalFound}
  dont sites présents chez nous       ${totalMatched}
  écrits                              ${dryRun ? "0 (dry run)" : totalWritten}
  cultures concernées                 ${perCulture.length}
──────────────────────────────────────────────────────────`);

  if (unbounded) {
    const uniq = [...new Set(unboundedCultures)];
    console.log(`
⚠ ${unbounded} attributions portent une culture SANS BORNES chronologiques.
  Elles seront rendues À TOUTE ÉPOQUE (un hull préhistorique peut donc
  apparaître en 1500 AD). Choix délibéré : masquer silencieusement serait pire.
  Correctif : compléter les bornes de ces entités (SPARQL puis passe LLM), puis
  relancer ce script — les bornes sont rafraîchies à chaque exécution.

  Cultures concernées (${uniq.length}) : ${uniq.slice(0, 12).join(", ")}${uniq.length > 12 ? "…" : ""}`);
  }

  await closeSql();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
