import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import { Eta } from "eta";
import path from "path";
import { fileURLToPath } from "url";

import { apiSitesRoutes } from "./routes/api/sites.js";
import { apiHullsRoutes } from "./routes/api/hulls.js";
import { apiPolitiesRoutes } from "./routes/api/polities.js";
import { apiCulturesRoutes } from "./routes/api/cultures.js";
import { pageSitesRoutes } from "./routes/pages/sites.js";
import { pagePolitiesRoutes } from "./routes/pages/polities.js";
import { pageCulturesRoutes } from "./routes/pages/cultures.js";
import { pageAboutRoutes } from "./routes/pages/about.js";
import { adminRoutes } from "./routes/admin/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== "production";
const PORT = Number(process.env.PORT ?? 3000);

// ── Body parser ─────────────────────────────────────────────────────────────
// Nécessaire pour les POST/PATCH JSON des routes admin

const app = Fastify({
  logger: isDev ? { transport: { target: "pino-pretty" } } : true,
});

// ── Content-type parsers ─────────────────────────────────────────────────────
// Fastify parse automatiquement application/json — mais on s'assure
// que les PATCH/POST admin avec Content-Type JSON fonctionnent
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  function (_req, body, done) {
    try {
      done(null, JSON.parse(body as string));
    } catch (err: any) {
      done(err, undefined);
    }
  },
);

// ── Templates Eta ─────────────────────────────────────────────────────────────
await app.register(fastifyView, {
  engine: { eta: new Eta() },
  root: path.join(__dirname, "../views"),
  layout: "layouts/base",
  defaultContext: {
    appName: "Strabon",
    year: new Date().getFullYear(),
  },
});

// ── Fichiers statiques ────────────────────────────────────────────────────────
// En prod : sert le build Vite depuis web/dist
// En dev : Vite tourne séparément sur :5173 avec proxy /api → :3000
if (!isDev) {
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "../../web/dist"),
    prefix: "/",
    decorateReply: false,
  });
}

// Fichiers publics du serveur (CSS compilé, favicon...)
await app.register(fastifyStatic, {
  root: path.join(__dirname, "../public"),
  prefix: "/public/",
  decorateReply: false,
});

// ── Routes API JSON ───────────────────────────────────────────────────────────
await app.register(apiSitesRoutes, { prefix: "/api" });
await app.register(apiHullsRoutes, { prefix: "/api" });
await app.register(apiPolitiesRoutes, { prefix: "/api" });
await app.register(apiCulturesRoutes, { prefix: "/api" });

// ── Routes pages HTML ─────────────────────────────────────────────────────────
await app.register(pageSitesRoutes);
await app.register(pagePolitiesRoutes);
await app.register(pageCulturesRoutes);
await app.register(pageAboutRoutes);

// ── Routes admin — plugin isolé avec layout admin ────────────────────────────
// Enregistré dans un sous-plugin pour avoir son propre @fastify/view
// avec layout: "admin/layout" sans affecter les pages publiques.
await app.register(async (adminApp) => {
  await adminApp.register(fastifyView, {
    engine: { eta: new Eta() },
    root: path.join(__dirname, "../views"),
    layout: "admin/layout",
    defaultContext: {
      appName: "Strabon Admin",
      year: new Date().getFullYear(),
    },
  });
  await adminApp.register(adminRoutes);
});

// ── SPA fallback (prod) — toutes les routes non reconnues → index.html ────────
if (!isDev) {
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile("index.html");
  });
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`🏛  Strabon server running on http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
