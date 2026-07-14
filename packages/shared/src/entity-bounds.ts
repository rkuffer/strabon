// =============================================================================
// entity-bounds.ts — Application des bornes chronologiques d'entités
//
// Fonction PURE : aucune IO. La logique vit ici, une seule fois. Le pipeline
// d'extraction, la confirmation back-office et le script de rattrapage en sont
// tous des APPELANTS. Écrire ces règles deux fois, c'est garantir qu'elles
// divergeront — probablement sur un cas limite qu'on aura oublié de recopier.
// =============================================================================

import { TRACK_META } from "./site-types.js";
import type { SiteTimeline, TrackKey } from "./site-types.js";

/** Pistes dont les entrées nomment une ENTITÉ, et peuvent donc être bornées. */
export const BOUNDED_TRACKS: readonly TrackKey[] = [
  "polity",
  "culture",
  "religion",
  "language",
];

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

function qidOf(e: any): string | null {
  const q =
    typeof e?.value?.wikidata === "string" ? e.value.wikidata.trim() : "";
  return q || null;
}

/**
 * Année où l'entrée cesse ACTUELLEMENT d'être affichée.
 *
 *   step        : la suivante la ferme, quelle que soit son entité.
 *   cooccurrent : seul un `to` explicite, ou une entrée ultérieure de la MÊME
 *                 entité (changement de rôle), la ferme.
 *
 * `null` = court jusqu'au bout. C'est la queue qu'on est là pour couper.
 */
function implicitEnd(
  entries: any[],
  i: number,
  track: TrackKey,
): number | null {
  const e = entries[i];
  if (e.to != null) return e.to;

  if (TRACK_META[track].regime === "step") {
    return i + 1 < entries.length ? entries[i + 1].from : null;
  }

  const key = qidOf(e) ?? e.value?.name ?? "";
  for (let j = i + 1; j < entries.length; j++) {
    const k = qidOf(entries[j]) ?? entries[j].value?.name ?? "";
    if (k === key) return entries[j].from;
  }
  return null;
}

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
export function applyEntityBounds(
  timeline: SiteTimeline,
  bounds: Map<string, EntityBounds>,
): { timeline: SiteTimeline; conflicts: BoundsConflict[] } {
  const tl = timeline as any;
  const conflicts: BoundsConflict[] = [];

  for (const track of BOUNDED_TRACKS) {
    const entries: any[] = tl[track]?.entries;
    if (!entries?.length) continue;

    entries.sort((a, b) => a.from - b.from);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const qid = qidOf(e);
      if (!qid) continue;

      const b = bounds.get(qid);
      if (!b) continue;

      const end = implicitEnd(entries, i, track);
      const base = {
        track,
        entity_qid: qid,
        entity_label: b.label,
        entry_from: e.from,
        entry_to: (e.to ?? null) as number | null,
        entity_inception: b.inception,
        entity_dissolution: b.dissolution,
      };

      // ── 3. INCOMPATIBLE — aucun recouvrement. On ne touche à rien. ──────────
      if (b.dissolution != null && e.from > b.dissolution) {
        conflicts.push({
          ...base,
          action: "incompatible",
          detail: `entry starts at ${e.from}, entity died in ${b.dissolution}`,
        });
        continue;
      }
      // Strict : une entrée qui finit PILE sur l'inception la recouvre encore.
      if (b.inception != null && end != null && end < b.inception) {
        conflicts.push({
          ...base,
          action: "incompatible",
          detail: `entry runs ${e.from}→${end}, entity born in ${b.inception}`,
        });
        continue;
      }

      // ── 2. SHORTEN — jamais jusqu'à annuler l'entrée. ───────────────────────
      if (
        b.inception != null &&
        e.from < b.inception &&
        (end == null || b.inception < end)
      ) {
        conflicts.push({
          ...base,
          action: "shorten",
          detail: `from ${e.from} → ${b.inception}`,
        });
        e.from = b.inception;
        if (b.inception_precision != null && b.inception_precision < 9) {
          e.from_circa = true;
          e.from_precision = b.inception_precision;
        }
      }

      // ── 1. CLOSE — évalué APRÈS shorten : une entrée peut avoir besoin des deux.
      if (
        b.dissolution != null &&
        (end == null || end > b.dissolution) &&
        b.dissolution >= e.from
      ) {
        conflicts.push({
          ...base,
          action: "close",
          detail:
            end == null
              ? `open tail → closed at ${b.dissolution}`
              : `ran to ${end} → closed at ${b.dissolution}`,
        });
        e.to = b.dissolution;
      }
    }
  }

  return { timeline: tl as SiteTimeline, conflicts };
}
