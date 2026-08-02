// =============================================================================
// backfill-titles.ts
// -----------------------------------------------------------------------------
// RATTRAPAGE des sites dont `title_en` vaut leur propre QID.
//
// Cause racine (mesurée, août 2026)
// ---------------------------------
// tile-processor.ts appelle le service de libellés avec `wikibase:language "en"`
// SEUL. Ce service ne retombe NI sur les variantes régionales (`en-gb`, `en-ca`)
// NI sur les autres langues : quand le libellé `en` exact manque, il retourne le
// QID lui-même, que `label: b.siteLabel?.value ?? qid` accueille comme un libellé
// légitime. Résultat : 551 610 sites (25,6 % de la base) titrés par leur QID.
//
// Ce ne sont PAS des sites sans nom. Vérifié sur Wikidata :
//   Q49255 (Tampa)  → 128 libellés, dont en-gb et en-ca = "Tampa", mais PAS de `en`
//   Q4035  (Osasco) → article enwiki existant, et `wikipedia_page_en_url` NULL chez nous
// Échantillons : Mexique 43/43 récupérables (libellé `es` = le toponyme) ;
// Russie 9/50 avec un libellé latin (translittérations `nb`/`nn` produites par
// bots), les 41 autres à libellé unique cyrillique — et ce sont précisément des
// artefacts mineurs (kourganes, gorodichtché, carrières).
//
// PÉRIMÈTRE (arbitré) : sitelinks > 0 uniquement. Les 135 859 sites à 0 sitelink
// sont la queue d'artefacts ; aucun site déjà `extracted` ou `queued` ne s'y
// trouve, donc rien de curé n'est laissé de côté.
//
// PAS DE TRANSLITTÉRATION ALGORITHMIQUE (arbitré). Translittérer n'est pas
// traduire (Курганы «Ознобишинские» → "Kurgany «Oznobishinskiye»" reste opaque),
// et cela fabriquerait une chaîne sans source, indiscernable ensuite d'un nom
// attesté. On récupère en revanche les translittérations DÉJÀ SOURCÉES sur
// Wikidata via l'étape « libellé en écriture latine » — `meta.title_source`
// enregistre la langue retenue, ce qui laisse la porte ouverte à un passage
// ciblé plus tard.
//
// GARDE D'IDEMPOTENCE : `title_en = wikidata_id` est une IDENTITÉ vérifiable
// (le titre est littéralement le QID du site), pas un match de forme. Elle est
// répétée dans le WHERE de l'UPDATE, donc le script ne peut JAMAIS écraser un
// vrai titre, même relancé, même concurrent.
//
// Usage :
//   DATABASE_URL=... npx -y tsx packages/scripts/src/backfill-titles.ts --dry-run
//   DATABASE_URL=... npx -y tsx packages/scripts/src/backfill-titles.ts --dry-run --limit 2000
//   DATABASE_URL=... npx -y tsx packages/scripts/src/backfill-titles.ts --apply
//   DATABASE_URL=... npx -y tsx packages/scripts/src/backfill-titles.ts --apply --country Q96
//
// `--dry-run` est le DÉFAUT : sans `--apply`, rien n'est écrit.
// =============================================================================

import { getSql, closeSql } from "@strabon/db";
import { wikiFetchJson } from "@strabon/shared";

const API = "https://www.wikidata.org/w/api.php";
const BATCH_SIZE = 50; // limite wbgetentities

// ── Chaîne de priorité ───────────────────────────────────────────────────────
// Variantes régionales de l'anglais : le cas Tampa. Le libellé nu ("Tampa") est
// préférable au titre d'article désambiguïsé ("Tampa, Florida"), donc les
// variantes passent AVANT le slug enwiki.
const EN_VARIANTS = ["en-gb", "en-ca", "en-us", "en-au", "en-nz", "en-simple"];

// Langues à écriture latine, par ordre de préférence. Sert d'étape 5 : on prend
// une translittération/forme latine SOURCÉE plutôt que le natif non latin.
// `nb`/`nn`/`sh`/`ceb` sont ici parce que les bots qui les alimentent produisent
// des translittérations de toponymes (mesuré sur la Russie), pas des traductions.
const LATIN_PREFERRED = [
  "fr",
  "de",
  "es",
  "it",
  "pt",
  "nl",
  "ca",
  "gl",
  "eu",
  "pl",
  "cs",
  "sk",
  "sl",
  "hr",
  "sh",
  "bs",
  "ro",
  "hu",
  "sv",
  "da",
  "nb",
  "nn",
  "fi",
  "et",
  "lv",
  "lt",
  "tr",
  "az",
  "id",
  "ms",
  "vi",
  "af",
  "sq",
  "cy",
  "ga",
  "eo",
  "ceb",
  "war",
  "la",
];

/** Vrai si tous les caractères alphabétiques de `s` sont en écriture latine. */
function isLatinScript(s: string): boolean {
  const letters = [...s].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return false;
  return letters.every((ch) => /\p{Script=Latin}/u.test(ch));
}

/** Titre lisible depuis une URL d'article Wikipédia (slug → texte). */
function titleFromWikipediaUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname; // /wiki/Carpi,_Emilia-Romagna
    const slug = path.replace(/^\/wiki\//, "");
    if (!slug) return null;
    return decodeURIComponent(slug).replace(/_/g, " ").trim() || null;
  } catch {
    return null;
  }
}

type Resolution = {
  title: string;
  /** Provenance écrite dans meta.title_source — rend chaque correction auditable. */
  source: string;
  /** Libellé natif (langue du pays), pour meta.native_label → search_text. */
  nativeLabel: string | null;
  /** Slug enwiki découvert, à écrire dans wikipedia_page_en_url si absent. */
  enwikiUrl: string | null;
};

/**
 * Applique la chaîne de priorité sur une entité wbgetentities.
 *
 * Ordre : en → variantes en-* → slug enwiki → langue du pays (si latine) →
 * langue latine préférée → toute langue latine → langue du pays (natif) →
 * n'importe quel libellé. Retourne null si l'entité n'a strictement aucun nom.
 */
function resolveTitle(
  entity: any,
  countryLang: string | null,
): Resolution | null {
  const labels: Record<string, string> = {};
  for (const [lang, v] of Object.entries<any>(entity?.labels ?? {})) {
    const val = (v?.value ?? "").trim();
    if (val) labels[lang] = val;
  }

  const enwikiTitle: string | null =
    entity?.sitelinks?.enwiki?.title?.trim() || null;
  const enwikiUrl = enwikiTitle
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(
        enwikiTitle.replace(/ /g, "_"),
      )}`
    : null;

  // Le libellé natif part dans meta.native_label quoi qu'il arrive : même quand
  // title_en reçoit une forme latine, le natif reste cherchable (le trigger
  // sites_search_text_trg agrège meta.native_label dans search_text).
  const nativeLabel = countryLang ? (labels[countryLang] ?? null) : null;

  const pick = (title: string, source: string): Resolution => ({
    title,
    source,
    nativeLabel,
    enwikiUrl,
  });

  if (labels.en) return pick(labels.en, "wikidata:en");

  for (const lang of EN_VARIANTS) {
    if (labels[lang]) return pick(labels[lang], `wikidata:${lang}`);
  }

  if (enwikiTitle) return pick(enwikiTitle, "enwiki-title");

  // Langue du pays d'abord SI elle est en écriture latine : pour le Mexique,
  // `es` donne le toponyme exact — inutile d'aller chercher ailleurs.
  if (countryLang && labels[countryLang] && isLatinScript(labels[countryLang]))
    return pick(labels[countryLang], `wikidata:${countryLang}`);

  for (const lang of LATIN_PREFERRED) {
    if (labels[lang] && isLatinScript(labels[lang]))
      return pick(labels[lang], `wikidata:${lang}`);
  }

  for (const [lang, val] of Object.entries(labels)) {
    if (isLatinScript(val)) return pick(val, `wikidata:${lang}`);
  }

  // Plus aucune forme latine : on écrit le natif (arbitré — un nom en cyrillique
  // est un nom, le QID n'est rien).
  if (countryLang && labels[countryLang])
    return pick(labels[countryLang], `wikidata:${countryLang}`);

  const first = Object.entries(labels)[0];
  if (first) return pick(first[1], `wikidata:${first[0]}`);

  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const limitRaw = get("--limit");
  const country = get("--country");
  const minImportanceRaw = get("--min-importance");
  return {
    apply,
    limit: limitRaw ? parseInt(limitRaw, 10) : null,
    country,
    minImportance: minImportanceRaw ? parseInt(minImportanceRaw, 10) : null,
  };
}

async function main() {
  const { apply, limit, country, minImportance } = parseArgs();
  const sql = getSql();

  console.log(
    `[backfill-titles] mode=${apply ? "APPLY (écriture)" : "DRY-RUN (aucune écriture)"}` +
      `${limit ? ` limit=${limit}` : ""}${country ? ` country=${country}` : ""}` +
      `${minImportance != null ? ` min-importance=${minImportance}` : ""}`,
  );

  // Table de langues par pays — pilote le choix du libellé natif.
  const countryRows = await sql`
    SELECT qid, lang_code FROM countries WHERE lang_code IS NOT NULL
  `;
  const countryLang = new Map<string, string>(
    (countryRows as any[]).map((r) => [r.qid, r.lang_code]),
  );

  // Sélection. Trois filtres, tous conservateurs :
  //   title_en = wikidata_id  → identité vérifiable, jamais un vrai titre
  //   sitelinks_count > 0     → périmètre arbitré (exclut la queue d'artefacts)
  //   title_backfill_attempted absent → ne re-tente pas les irrécupérables
  // Tri par importance décroissante : la valeur atterrit d'abord, et le script
  // peut être interrompu à tout moment sans perdre le bénéfice acquis.
  const rows = await sql`
    SELECT s.id, s.wikidata_id, s.country_qid, s.base_importance,
           s.wikipedia_page_en_url
    FROM sites s
    WHERE s.title_en = s.wikidata_id
      AND COALESCE(s.sitelinks_count, 0) > 0
      AND s.meta->>'title_backfill_attempted' IS NULL
      ${country ? sql`AND s.country_qid = ${country}` : sql``}
      ${minImportance != null ? sql`AND s.base_importance >= ${minImportance}` : sql``}
    ORDER BY s.base_importance DESC NULLS LAST, s.id
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;

  const sites = rows as any[];
  console.log(`[backfill-titles] ${sites.length} site(s) à traiter\n`);
  if (!sites.length) {
    await closeSql();
    return;
  }

  const bySource = new Map<string, number>();
  const samples: string[] = [];
  let resolved = 0;
  let unresolved = 0;
  let enwikiFilled = 0;
  let nativeStored = 0;
  let apiErrors = 0;

  const totalBatches = Math.ceil(sites.length / BATCH_SIZE);

  for (let b = 0; b < totalBatches; b++) {
    const batch = sites.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const ids = batch.map((s) => s.wikidata_id).join("|");

    // sitefilter=enwiki : sans lui, la réponse embarque TOUS les sitelinks de
    // chaque entité (jusqu'à 200+ par gros site) pour un seul qui nous intéresse.
    const url =
      `${API}?action=wbgetentities&ids=${ids}` +
      `&props=labels|sitelinks&sitefilter=enwiki&format=json&formatversion=2`;

    let data: any;
    try {
      data = await wikiFetchJson(url);
    } catch (err: any) {
      apiErrors++;
      console.warn(
        `[backfill-titles] ⚠ lot ${b + 1}/${totalBatches} échoué : ${err.message}`,
      );
      continue;
    }

    const entities = data?.entities ?? {};

    for (const site of batch) {
      const entity = entities[site.wikidata_id];
      const res = entity
        ? resolveTitle(entity, countryLang.get(site.country_qid) ?? null)
        : null;

      if (!res) {
        unresolved++;
        if (apply) {
          // Marque la tentative pour ne pas repayer l'appel au prochain passage.
          // On ne touche PAS title_en : le QID reste, faute de mieux.
          // Même construction en JS que plus bas — voir la note sur 42P18.
          const attempted = JSON.stringify({
            title_backfill_attempted: new Date().toISOString(),
          });
          await sql`
            UPDATE sites
            SET meta = COALESCE(meta, '{}'::jsonb) || ${attempted}::jsonb
            WHERE id = ${site.id} AND title_en = wikidata_id
          `;
        }
        continue;
      }

      resolved++;
      bySource.set(res.source, (bySource.get(res.source) ?? 0) + 1);
      if (res.nativeLabel) nativeStored++;
      const fillEnwiki = !site.wikipedia_page_en_url && res.enwikiUrl;
      if (fillEnwiki) enwikiFilled++;

      if (samples.length < 25) {
        samples.push(
          `  ${site.wikidata_id.padEnd(12)} imp=${String(site.base_importance ?? "").padStart(3)}` +
            `  → ${JSON.stringify(res.title).padEnd(38)} [${res.source}]` +
            `${fillEnwiki ? " +enwiki" : ""}`,
        );
      }

      if (apply) {
        // La garde `title_en = wikidata_id` est REPÉTÉE ici : entre le SELECT et
        // cet UPDATE, un curateur a pu nommer le site à la main — dans ce cas la
        // ligne ne matche plus et son travail n'est pas écrasé.
        //
        // wikipedia_page_en_url n'est rempli QUE s'il est NULL (COALESCE côté
        // colonne existante) : on ne remplace jamais une URL déjà connue.
        // Effet de bord assumé : base_importance étant une colonne GÉNÉRÉE avec
        // un bonus de +8 sur cette colonne, la remplir relève l'importance du
        // site et peut le faire apparaître à des seuils de zoom plus larges.
        //
        // Le patch meta est construit en JS puis passé en UN paramètre casté en
        // jsonb. Surtout PAS `jsonb_build_object('k', ${valeur})` : cette
        // fonction est déclarée "any", donc Postgres ne peut pas inférer le type
        // du paramètre et refuse la requête (42P18 « could not determine data
        // type of parameter »).
        const metaPatch: Record<string, string> = {
          title_source: res.source,
          title_backfill_attempted: new Date().toISOString(),
        };
        if (res.nativeLabel) metaPatch.native_label = res.nativeLabel;

        await sql`
          UPDATE sites
          SET title_en = ${res.title},
              wikipedia_page_en_url = COALESCE(wikipedia_page_en_url, ${res.enwikiUrl}),
              meta = COALESCE(meta, '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb,
              last_updated = now()
          WHERE id = ${site.id} AND title_en = wikidata_id
        `;
      }
    }

    if ((b + 1) % 20 === 0 || b === totalBatches - 1) {
      const pct = Math.round(((b + 1) / totalBatches) * 100);
      console.log(
        `  lot ${b + 1}/${totalBatches} (${pct}%) — résolus ${resolved}, sans nom ${unresolved}`,
      );
    }
  }

  // ── Rapport ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(70)}`);
  console.log(`RÉSULTAT — ${apply ? "APPLIQUÉ" : "SIMULATION (rien écrit)"}`);
  console.log("─".repeat(70));
  console.log(`  sites traités        : ${sites.length}`);
  console.log(
    `  titres résolus       : ${resolved} (${Math.round((100 * resolved) / sites.length)}%)`,
  );
  console.log(`  aucun nom trouvé     : ${unresolved}`);
  console.log(
    `  libellé natif stocké : ${nativeStored}  (→ meta.native_label, alimente search_text)`,
  );
  console.log(
    `  wikipedia_page_en_url à remplir : ${enwikiFilled}  ⚠ relève base_importance (+8)`,
  );
  if (apiErrors)
    console.log(
      `  lots API en échec    : ${apiErrors} (relancer le script les reprendra)`,
    );

  console.log(`\n  Provenance des titres retenus :`);
  const sorted = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  for (const [source, n] of sorted) {
    const pct = Math.round((100 * n) / Math.max(resolved, 1));
    console.log(
      `    ${source.padEnd(22)} ${String(n).padStart(7)}  ${String(pct).padStart(3)}%`,
    );
  }

  console.log(`\n  Échantillon :`);
  for (const s of samples) console.log(s);

  if (!apply) {
    console.log(
      `\n  Simulation uniquement. Relancer avec --apply pour écrire.\n` +
        `  Conseil : vérifier d'abord la colonne « provenance » ci-dessus — une\n` +
        `  langue inattendue en tête signale une chaîne de priorité à ajuster.`,
    );
  }

  await closeSql();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
