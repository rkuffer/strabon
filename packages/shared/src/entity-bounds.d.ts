import type { SiteTimeline, TrackKey } from "./site-types.js";
/** Pistes dont les entrées nomment une ENTITÉ, et peuvent donc être bornées. */
export declare const BOUNDED_TRACKS: readonly TrackKey[];
export type EntityBounds = {
    label: string;
    inception: number | null;
    inception_precision: number | null;
    dissolution: number | null;
    dissolution_precision: number | null;
};
export type BoundsAction = "close" | "shorten" | "incompatible";
export type BoundsConflict = {
    track: TrackKey;
    entity_qid: string;
    entity_label: string;
    entry_from: number;
    entry_to: number | null;
    entity_inception: number | null;
    entity_dissolution: number | null;
    action: BoundsAction;
    detail: string;
};
/**
 * Applique les bornes d'entités à une timeline. Retourne la timeline MODIFIÉE
 * et la liste des actions.
 *
 * UNE BORNE EST UN PLAFOND, JAMAIS UNE VÉRITÉ. On n'élargit jamais ; on ne coupe
 * que là où couper ne peut pas détruire un fait.
 *
 *   1. CLOSE — l'entrée dépasse la dissolution de l'entité.
 *      → `to = dissolution`. AUTOMATIQUE. On AJOUTE une information manquante,
 *      on n'efface rien : l'entrée garde son nom, son début, ses notes.
 *
 *   2. SHORTEN — l'entrée commence avant la naissance de l'entité, mais elles se
 *      RECOUVRENT. → on remonte `from` à l'inception. AUTOMATIQUE.
 *      C'est un SOUS-INTERVALLE de ce que le modèle a déjà affirmé : on en dit
 *      moins que lui, jamais autre chose. Et l'entrée HÉRITE de l'imprécision de
 *      l'entité — sans quoi on transformerait « vers -4500 » en date sèche.
 *
 *   3. INCOMPATIBLE — aucun recouvrement. → ON NE TOUCHE À RIEN.
 *      Il n'y a rien à raccourcir : l'entrée et l'entité sont irréconciliables, et
 *      on ne peut pas savoir LAQUELLE des deux est fausse. Wikidata encode de la
 *      légende médiévale avec une précision à l'année (le royaume de Munster
 *      « naît » en 100 av. J.-C. parce que les chroniqueurs irlandais avaient
 *      besoin de lignées longues). Supprimer un fait vrai sur la foi d'une borne
 *      fausse remplacerait une erreur par une autre, moins visible.
 *      Une entrée fausse mais VISIBLE se cure. Une entrée supprimée est un trou muet.
 */
export declare function applyEntityBounds(timeline: SiteTimeline, bounds: Map<string, EntityBounds>): {
    timeline: SiteTimeline;
    conflicts: BoundsConflict[];
};
//# sourceMappingURL=entity-bounds.d.ts.map