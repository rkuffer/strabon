// packages/shared/src/time-scale.ts
// Algorithmes de transformation temporelle partagés entre TimeRuler et TimelineTrack

export type ScaleMode = "sqrt" | "linear" | "log";

export const GLOBAL_MIN = -10000;
export const GLOBAL_MAX = 2000;

/**
 * Transforme une année en position relative [0..1] selon le mode d'échelle.
 * 0 = extrémité gauche (passé lointain), 1 = extrémité droite (présent).
 * Les modes non-linéaires compriment le passé lointain et étire le présent.
 */
export function toScale(
  year: number,
  mode: ScaleMode,
  min = GLOBAL_MIN,
  max = GLOBAL_MAX,
): number {
  const t = (year - min) / (max - min); // [0..1] linéaire
  switch (mode) {
    case "linear":
      return t;
    case "sqrt":
      // 1 - √(1-t) : compression douce du passé, étirement du présent
      return 1 - Math.sqrt(1 - t);
    case "log": {
      // Compression agressive : log(1 + (1-t)*k) inversé
      const k = 20;
      return 1 - Math.log1p((1 - t) * k) / Math.log1p(k);
    }
  }
}

/**
 * Inverse de toScale : convertit une position [0..1] en année.
 * Indispensable pour le drag sur la frise.
 */
export function fromScale(
  pos: number,
  mode: ScaleMode,
  min = GLOBAL_MIN,
  max = GLOBAL_MAX,
): number {
  let t: number;
  switch (mode) {
    case "linear":
      t = pos;
      break;
    case "sqrt":
      t = 1 - Math.pow(1 - pos, 2);
      break;
    case "log": {
      const k = 20;
      t = 1 - (Math.exp((1 - pos) * Math.log1p(k)) - 1) / k;
      break;
    }
  }
  return Math.round(min + t * (max - min));
}

/**
 * Convertit une année en pourcentage CSS [0..100] selon le mode.
 */
export function toPct(
  year: number,
  mode: ScaleMode,
  min = GLOBAL_MIN,
  max = GLOBAL_MAX,
): number {
  return toScale(year, mode, min, max) * 100;
}

export const SCALE_LABELS: Record<ScaleMode, string> = {
  sqrt: "Racine carrée",
  linear: "Linéaire",
  log: "Logarithmique",
};

/**
 * Segments de granularité de la frise (Option C).
 * Définit le pas temporel par période — utilisé par la frise ET par le play.
 */
export const FRISE_SEGMENTS = [
  { from: -10000, to: -5000, step: 1000 },
  { from: -5000, to: -3200, step: 500 },
  { from: -3200, to: -1200, step: 100 },
  { from: -1200, to: 1500, step: 50 },
  { from: 1500, to: 1800, step: 50 },
  { from: 1800, to: 2000, step: 10 },
] as const;

/**
 * Retourne le pas temporel correspondant à l'année courante.
 * Correspond exactement à la taille d'une case de la frise.
 */
export function getPlayStep(year: number): number {
  for (const seg of FRISE_SEGMENTS) {
    if (year >= seg.from && year < seg.to) return seg.step;
  }
  // Fallback : dernière case
  return FRISE_SEGMENTS[FRISE_SEGMENTS.length - 1].step;
}
