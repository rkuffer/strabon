/**
 * Hull colours are DERIVED, never stored.
 *
 * Two regimes:
 *
 *   - Entity has a `family_qid` (religion, language): the FAMILY drives the hue.
 *     All Indo-European languages share a hue range; all Abrahamic religions
 *     share another. Within a family, the entity's own QID picks a variant
 *     (lightness + saturation ladder). The map becomes readable at a glance and
 *     the legend becomes meaningful.
 *
 *   - No family (polity, culture): the entity's QID drives the hue directly.
 *
 * Hues are distributed by the golden angle, which maximises the spacing between
 * successive hashes. This does NOT guarantee contrast between geographically
 * adjacent hulls — that is the four-colour problem, and solving it per-year
 * would make an entity change colour as its neighbours come and go, destroying
 * its identity during timeline playback. Contrast between contiguous hulls is
 * carried by the STROKE (a darker shade of the fill), as in every printed
 * historical atlas.
 */
const GOLDEN_RATIO_CONJUGATE = 0.618033988749895;
/** FNV-1a, 32-bit. Deterministic and stable across runs and machines. */
function hash32(input) {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** Maps a hash onto the hue wheel via the golden angle. */
function goldenHue(seed) {
    const n = hash32(seed) / 0xffffffff;
    return ((n + GOLDEN_RATIO_CONJUGATE) % 1) * 360;
}
// Variant ladders used to separate entities that share a hue (same family).
const SATURATIONS = [62, 48, 74, 38];
const LIGHTNESSES = [52, 42, 62, 34, 70];
/** Fill colour of a hull. Pure function of the entity's identity. */
export function hullFillColor({ qid, familyQid }) {
    const seed = familyQid && familyQid.length > 0 ? familyQid : qid;
    const hue = goldenHue(seed);
    // Within a family, spread the members across the sat/lum ladders.
    // Without a family, the ladders still add variation between close hues.
    const v = hash32(qid);
    const sat = SATURATIONS[v % SATURATIONS.length];
    const lum = LIGHTNESSES[Math.floor(v / SATURATIONS.length) % LIGHTNESSES.length];
    // Within a family, nudge the hue slightly so members are not identical in hue
    // either — but stay inside the family's neighbourhood (+/- 12 degrees).
    const hueNudge = familyQid ? (v % 25) - 12 : 0;
    return `hsl(${((hue + hueNudge) % 360).toFixed(1)} ${sat}% ${lum}%)`;
}
/** Stroke colour: the fill, darkened. This is what separates contiguous hulls. */
export function hullStrokeColor(input) {
    const fill = hullFillColor(input);
    const m = /hsl\(([\d.]+) (\d+)% (\d+)%\)/.exec(fill);
    if (!m)
        return fill;
    const [, h, s, l] = m;
    const darker = Math.max(12, Number(l) - 24);
    return `hsl(${h} ${Math.min(100, Number(s) + 12)}% ${darker}%)`;
}
//# sourceMappingURL=hull-color.js.map