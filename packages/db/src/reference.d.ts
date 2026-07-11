import type { Polity, Culture, SiteTimeline } from "@strabon/shared";
export declare function getAllPolities(): Promise<Polity[]>;
export declare function upsertPolity(polity: Polity): Promise<void>;
export declare function getAllCultures(): Promise<Culture[]>;
export declare function upsertCulture(culture: Culture): Promise<void>;
export declare function syncReferentialsFromTimeline(timeline: SiteTimeline): Promise<{
    polities: number;
    cultures: number;
}>;
//# sourceMappingURL=reference.d.ts.map