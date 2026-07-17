export type WikidataBounds = {
    qid: string;
    inception: number | null;
    inception_precision: number | null;
    dissolution: number | null;
    dissolution_precision: number | null;
};
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
export declare function parseWikidataYear(value: string): number | null;
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
export declare function buildBoundsQuery(qids: string[]): string;
/**
 * Réduit les lignes SPARQL en bornes, une par entité.
 *
 * FENÊTRE LA PLUS LARGE : plusieurs P571 ⇒ on garde la PLUS ANCIENNE ; plusieurs
 * P576 ⇒ la PLUS RÉCENTE. Une borne est un PLAFOND, jamais une vérité — on
 * préfère couper trop peu que trop.
 */
export declare function parseBoundsRows(rows: any[]): Map<string, WikidataBounds>;
//# sourceMappingURL=wikidata-bounds.d.ts.map