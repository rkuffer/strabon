export { getSql, closeSql } from "./client.js";
export { querySites, getSiteById, upsertSite, searchSites } from "./sites.js";
export { queryHulls, type HullQueryOptions } from "./hulls.js";
export {
  getAllPolities,
  upsertPolity,
  getAllCultures,
  upsertCulture,
  syncReferentialsFromTimeline,
} from "./reference.js";
export {
  searchEntities,
  getEntityDetail,
  type EntityCandidate,
  type EntityDetail,
} from "./entities.js";
export { loadEntityBounds, recordBoundsConflicts } from "./bounds.js";
export {
  recordGaps,
  verifyQid,
  backfillSites,
  autoResolveGaps,
  resolveGapManually,
  rejectGap,
  type MissingEntity,
  type VerificationResult,
  type ResolutionOutcome,
} from "./referential-gaps.js";
export {
  fetchAndStoreBounds,
  reapplyBoundsToSites,
  syncBoundsForNewEntity,
} from "./entity-bounds-sync.js";
