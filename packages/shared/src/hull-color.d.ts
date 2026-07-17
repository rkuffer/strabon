import type { HullKind } from "./site-types.js";
export type HullColorInput = {
    kind: HullKind;
    qid: string;
    familyQid?: string | null;
};
/** Fill colour of a hull. Pure function of the entity's identity. */
export declare function hullFillColor({ qid, familyQid }: HullColorInput): string;
/** Stroke colour: the fill, darkened. This is what separates contiguous hulls. */
export declare function hullStrokeColor(input: HullColorInput): string;
//# sourceMappingURL=hull-color.d.ts.map