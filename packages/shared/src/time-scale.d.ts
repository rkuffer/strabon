export type ScaleMode = "sqrt" | "linear" | "log";
export declare const GLOBAL_MIN = -10000;
export declare const GLOBAL_MAX = 2000;
/**
 * Transforme une année en position relative [0..1] selon le mode d'échelle.
 * 0 = extrémité gauche (passé lointain), 1 = extrémité droite (présent).
 * Les modes non-linéaires compriment le passé lointain et étire le présent.
 */
export declare function toScale(year: number, mode: ScaleMode, min?: number, max?: number): number;
/**
 * Inverse de toScale : convertit une position [0..1] en année.
 * Indispensable pour le drag sur la frise.
 */
export declare function fromScale(pos: number, mode: ScaleMode, min?: number, max?: number): number;
/**
 * Convertit une année en pourcentage CSS [0..100] selon le mode.
 */
export declare function toPct(year: number, mode: ScaleMode, min?: number, max?: number): number;
export declare const SCALE_LABELS: Record<ScaleMode, string>;
/**
 * Segments de granularité de la frise (Option C).
 * Définit le pas temporel par période — utilisé par la frise ET par le play.
 */
export declare const FRISE_SEGMENTS: readonly [{
    readonly from: -10000;
    readonly to: -5000;
    readonly step: 1000;
}, {
    readonly from: -5000;
    readonly to: -3200;
    readonly step: 500;
}, {
    readonly from: -3200;
    readonly to: -1200;
    readonly step: 100;
}, {
    readonly from: -1200;
    readonly to: 1500;
    readonly step: 50;
}, {
    readonly from: 1500;
    readonly to: 1800;
    readonly step: 50;
}, {
    readonly from: 1800;
    readonly to: 2000;
    readonly step: 10;
}];
/**
 * Retourne le pas temporel correspondant à l'année courante.
 * Correspond exactement à la taille d'une case de la frise.
 */
export declare function getPlayStep(year: number): number;
//# sourceMappingURL=time-scale.d.ts.map