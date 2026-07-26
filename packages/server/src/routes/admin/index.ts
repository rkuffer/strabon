// packages/server/src/routes/admin/index.ts
import type { FastifyPluginAsync } from "fastify";
import { adminDashboardRoutes } from "./dashboard.js";
import { adminSitesRoutes } from "./sites.js";
import { adminExtractRoutes } from "./extract.js";
import { adminCurationRoutes } from "./curation.js";
import { adminGapsRoutes } from "./gaps.js";
import { adminEntitiesRoutes } from "./entities.js";
import { adminBoundsRoutes } from "./bounds.js";
import { adminAttributionsRoutes } from "./attributions.js";

export const adminRoutes: FastifyPluginAsync = async (app) => {
  await app.register(adminDashboardRoutes);
  await app.register(adminSitesRoutes);
  await app.register(adminExtractRoutes);
  await app.register(adminCurationRoutes);
  await app.register(adminGapsRoutes);
  await app.register(adminEntitiesRoutes);
  await app.register(adminBoundsRoutes);
  await app.register(adminAttributionsRoutes);
};
