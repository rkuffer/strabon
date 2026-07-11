export type EntityCandidate = {
    qid: string;
    kind: string;
    label_en: string;
    description_en: string | null;
    country_qid: string | null;
    score: number;
};
/**
 * Cherche des entités d'autorité par nom.
 *
 * @param query  Nom recherché (ex. "Roman Republic"). Min. 2 caractères.
 * @param opts.kind   Filtre optionnel sur la nature ("polity" | "culture" | …).
 * @param opts.limit  Nombre max de candidats (défaut 8, plafond 25).
 * @returns Candidats triés par pertinence décroissante.
 */
export declare function searchEntities(query: string, opts?: {
    kind?: string | null;
    limit?: number;
}): Promise<EntityCandidate[]>;
//# sourceMappingURL=entities.d.ts.map