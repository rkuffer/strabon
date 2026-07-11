import type { SiteState } from "@strabon/shared";
import type { SiteSearchResult } from "@strabon/shared";
export type SiteFilter = "timeline_only" | "all" | "no_timeline";
export type SitesQueryParams = {
    year: number;
    zoom: number;
    threshold: number;
    filter?: SiteFilter;
    bboxMinLon: number;
    bboxMinLat: number;
    bboxMaxLon: number;
    bboxMaxLat: number;
};
/**
 * Récupère les sites visibles dans un bounding box à une année donnée,
 * filtrés par score d'importance selon le zoom.
 * Retourne l'état courant (site_type, polity, culture) déjà résolu.
 * Les sites en hiatus d'occupation (site_occupied_at) sont exclus.
 */
export declare function querySites(params: SitesQueryParams): Promise<SiteState[]>;
/**
 * Récupère une entrée complète par ID (pour le panneau de détail).
 * NB : volontairement sans filtre d'occupation — un site en hiatus reste
 * consultable, le panneau timeline montre l'histoire complète (trou compris).
 */
export declare function getSiteById(id: string): Promise<import("postgres").Row>;
/**
 * Upsert d'une entrée site (utilisé par migrate.ts et enricher.ts).
 */
export declare function upsertSite(site: {
    id: string;
    wikidata_id?: string;
    title_en: string;
    wikipedia_page_en_url?: string;
    source?: string;
    lat?: number;
    lon?: number;
    country?: string;
    country_qid?: string;
    inception_year?: number;
    dissolution_year?: number;
    site_type?: string;
    base_importance?: number;
    names?: Record<string, string>;
    timeline?: object;
    meta?: object;
    wikidata_enriched_at?: Date;
    timeline_extracted_at?: Date;
    timeline_extraction_model?: string;
}): Promise<void>;
/**
 * Recherche souple par nom sur tous les noms connus (search_text), insensible
 * aux accents. Combine word_similarity (flou, tolère les fautes) et LIKE
 * sous-chaîne, classe par score puis importance. Ignore année/bbox/zoom.
 */
export declare function searchSites(q: string, limit?: number): Promise<SiteSearchResult[]>;
//# sourceMappingURL=sites.d.ts.map