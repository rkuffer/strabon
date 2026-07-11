// packages/server/src/routes/admin/index.ts
import type { FastifyPluginAsync } from "fastify";
import { adminDashboardRoutes } from "./dashboard.js";
import { adminSitesRoutes } from "./sites.js";
import { adminIndexRoutes } from "./indexer.js";
import { adminEnrichRoutes } from "./enrich.js";
import { adminExtractRoutes } from "./extract.js";
import { adminPolitiesRoutes } from "./polities.js";
import { adminCulturesRoutes } from "./cultures.js";
import { adminCurationRoutes } from "./curation.js";
import { adminGapsRoutes } from "./gaps.js";

export const adminRoutes: FastifyPluginAsync = async (app) => {
  await app.register(adminDashboardRoutes);
  await app.register(adminSitesRoutes);
  await app.register(adminIndexRoutes);
  await app.register(adminEnrichRoutes);
  await app.register(adminExtractRoutes);
  await app.register(adminPolitiesRoutes);
  await app.register(adminCulturesRoutes);
  await app.register(adminCurationRoutes);
  await app.register(adminGapsRoutes);
};
