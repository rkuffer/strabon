// =============================================================================
// site-types.ts — Types partagés Strabon
// Importé par @strabon/db, @strabon/server, @strabon/scripts, @strabon/web
// =============================================================================
export const ROLE_ORDER = [
    "state",
    "major",
    "minor",
    "minority",
];
/** Rang d'un rôle pour le tri (0 = le plus dominant). Inconnu ⇒ dernier. */
export function roleRank(role) {
    const i = role ? ROLE_ORDER.indexOf(role) : -1;
    return i === -1 ? ROLE_ORDER.length : i;
}
/** Ordre narratif des pistes — utilisé tel quel pour le rendu. */
export const TRACK_KEYS = [
    "site_type",
    "polity",
    "culture",
    "religion",
    "language",
    "name",
    "population",
];
export const TRACK_META = {
    site_type: {
        key: "site_type",
        label: "TYPE",
        regime: "occupation",
        hasRole: false,
        // `to` = hiatus d'occupation. Lu par isInOccupationGap, PAS par la lecture
        // de valeur — les deux préoccupations restent orthogonales.
        closable: false,
    },
    polity: {
        key: "polity",
        label: "POLITY",
        regime: "step",
        hasRole: false,
        closable: true,
    },
    culture: {
        key: "culture",
        label: "CULTURE",
        regime: "step",
        hasRole: false,
        closable: true,
    },
    religion: {
        key: "religion",
        label: "RELIGION",
        regime: "cooccurrent",
        hasRole: true,
        closable: true,
    },
    language: {
        key: "language",
        label: "LANGUAGE",
        regime: "cooccurrent",
        hasRole: true,
        closable: true,
    },
    name: {
        key: "name",
        label: "NAME",
        regime: "step",
        hasRole: false,
        closable: false,
    },
    population: {
        key: "population",
        label: "POP.",
        regime: "step",
        hasRole: false,
        closable: false,
    },
};
/** Pistes dont une entrée peut être fermée explicitement par un `to`. */
export const CLOSABLE_TRACK_KEYS = TRACK_KEYS.filter((k) => TRACK_META[k].closable);
export function isClosable(key) {
    return TRACK_META[key].closable;
}
/** Pistes admettant plusieurs valeurs actives simultanément. */
export const COOCCURRENT_TRACK_KEYS = TRACK_KEYS.filter((k) => TRACK_META[k].regime === "cooccurrent");
export function isCooccurrent(key) {
    return TRACK_META[key].regime === "cooccurrent";
}
export const HULL_KINDS = [
    "polity",
    "culture",
    "religion",
    "language",
];
//# sourceMappingURL=site-types.js.map