import type { HullFeature } from "@strabon/shared";
/**
 * Calcule les enveloppes concaves des polities à une année donnée.
 * - Clustering DBSCAN pour séparer les groupes géographiquement distants
 * - Intersection avec les terres émergées (ne_land) pour exclure les surfaces maritimes
 * - Exclut les sites en hiatus d'occupation (site_occupied_at)
 */
export declare function queryPolityHulls(year: number): Promise<HullFeature[]>;
/**
 * Calcule les enveloppes concaves des cultures à une année donnée.
 * Même logique : clustering DBSCAN + intersection terres émergées + exclusion hiatus.
 */
export declare function queryCultureHulls(year: number): Promise<HullFeature[]>;
//# sourceMappingURL=hulls.d.ts.map