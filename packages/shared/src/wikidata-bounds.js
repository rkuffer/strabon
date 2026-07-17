// =============================================================================
// wikidata-bounds.ts — Lecture des bornes chronologiques depuis Wikidata
//
// PUR : construit la requête, parse la réponse. Ne fait AUCUNE IO — le fetch
// appartient à l'appelant, parce que le script (batch de 150, retry, backoff) et
// le serveur (un QID, à la volée) ont des besoins légitimement différents.
//
// Ce qui ne doit exister qu'ICI, c'est la partie subtile : la conversion des
// années astronomiques, la fenêtre la plus large, la précision.
// =============================================================================
/** Bien avant tout site habité. Wikidata autorise des précisions géologiques :
 *  une entité du référentiel porte une inception à -84 000 000 000, six fois
 *  l'âge de l'univers. Ce n'est pas une borne qu'on a raté, c'est une borne qui
 *  ne veut rien dire pour un atlas de 12 000 ans. On la rejette. */
const MIN_YEAR = -200_000;
const MAX_YEAR = 2_100;
/**
 * Valeurs de temps Wikidata : "-0249-01-01T00:00:00Z" ou "1991-12-26T00:00:00Z".
 *
 * Le "+" documenté pour les années positives N'EST PAS toujours émis — le signe
 * doit être optionnel, sinon toutes les dates AD sont silencieusement écartées.
 *
 * Et l'export RDF de Wikidata utilise les ANNÉES ASTRONOMIQUES (XSD 1.1 : 1 av.
 * J.-C. = année 0), là où nos timelines utilisent les années HISTORIQUES (pas
 * d'an 0). 753 av. J.-C. vaut -0752 chez Wikidata et -753 chez nous. Sans cette
 * conversion, TOUTE borne avant J.-C. est décalée d'un an — silencieusement, et
 * dans la direction exacte qui produit de faux raccourcissements sur l'Antiquité.
 * Vérifié sur trois dates canoniques : fondation de Rome, la République, l'Empire.
 * Réf. https://www.wikidata.org/wiki/Help:Dates
 */
export function parseWikidataYear(value) {
    const m = /^([+-]?)(\d+)-/.exec(value);
    if (!m)
        return null;
    const year = parseInt(m[2], 10);
    if (Number.isNaN(year))
        return null;
    const signed = m[1] === "-" ? -year : year;
    if (signed < MIN_YEAR || signed > MAX_YEAR)
        return null;
    return signed <= 0 ? signed - 1 : signed;
}
/**
 * P571 (inception) / P576 (dissolved) sont le couple canonique. P580 (start
 * time) / P582 (end time) sont le repli : beaucoup d'anciens pays modélisent
 * leur existence comme une période plutôt que comme une fondation.
 *
 * CRITIQUE : passer par p:/psv: UNIQUEMENT, jamais par wdt:. Le prédicat `wdt:`
 * n'expose que la valeur PRÉFÉRÉE d'une déclaration — une entité aux
 * déclarations multiples ou disputées (l'URSS a deux inceptions, dont une
 * marquée "statement disputed by") n'expose alors RIEN, et la jointure la fait
 * disparaître en silence. C'est ce qui avait fait manquer l'Union soviétique, la
 * Northumbrie et le Danemark-Norvège : le bug mordait le plus fort sur les
 * entités qui comptent le plus, parce que ce sont celles qui ont assez
 * d'éditeurs pour avoir des déclarations contestées.
 */
export function buildBoundsQuery(qids) {
    const values = qids.map((q) => `wd:${q}`).join(" ");
    return `
SELECT ?e ?kind ?time ?precision WHERE {
  VALUES ?e { ${values} }
  {
    ?e p:P571 ?st . ?st psv:P571 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("inception" AS ?kind)
  } UNION {
    ?e p:P580 ?st . ?st psv:P580 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("inception" AS ?kind)
  } UNION {
    ?e p:P576 ?st . ?st psv:P576 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("dissolution" AS ?kind)
  } UNION {
    ?e p:P582 ?st . ?st psv:P582 ?n .
    ?n wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
    BIND("dissolution" AS ?kind)
  }
}`;
}
/**
 * Réduit les lignes SPARQL en bornes, une par entité.
 *
 * FENÊTRE LA PLUS LARGE : plusieurs P571 ⇒ on garde la PLUS ANCIENNE ; plusieurs
 * P576 ⇒ la PLUS RÉCENTE. Une borne est un PLAFOND, jamais une vérité — on
 * préfère couper trop peu que trop.
 */
export function parseBoundsRows(rows) {
    const out = new Map();
    for (const r of rows) {
        const qid = r.e.value.replace("http://www.wikidata.org/entity/", "");
        const year = parseWikidataYear(r.time.value);
        if (year === null)
            continue;
        const precision = parseInt(r.precision.value, 10);
        const cur = out.get(qid) ?? {
            qid,
            inception: null,
            inception_precision: null,
            dissolution: null,
            dissolution_precision: null,
        };
        if (r.kind.value === "inception") {
            if (cur.inception === null || year < cur.inception) {
                cur.inception = year;
                cur.inception_precision = precision;
            }
        }
        else {
            if (cur.dissolution === null || year > cur.dissolution) {
                cur.dissolution = year;
                cur.dissolution_precision = precision;
            }
        }
        out.set(qid, cur);
    }
    return out;
}
//# sourceMappingURL=wikidata-bounds.js.map