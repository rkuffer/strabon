# Strabon 2

Temporal atlas of archaeological sites and historical cities.

## Stack

- **Backend** : Fastify 5 + Eta templates + PostgreSQL/PostGIS
- **Frontend SPA** : Vue 3 + Vite + PrimeVue + TanStack Query + Leaflet
- **Pages SSR** : Eta templates rendus par Fastify
- **DB** : postgres.js (SQL brut, pas d'ORM)
- **Shared** : types TypeScript + utils timeline

## Démarrage rapide

```bash
# 1. Copier la config
cp .env.example .env
# Éditer DATABASE_URL dans .env

# 2. Créer la base de données
psql -U postgres -c "CREATE DATABASE strabon;"
psql -U postgres -d strabon -f packages/db/src/schema.sql

# 3. Installer les dépendances
npm install

# 4. Migrer les données JSON existantes
npm run migrate -w @strabon/scripts

# 5. Lancer en développement (Fastify :3000 + Vite :5173)
npm run dev
```

## Structure

```
packages/
  shared/    — Types TypeScript + utils timeline partagés
  db/        — Client PostgreSQL + requêtes SQL
  server/    — API Fastify + pages HTML (Eta)
  web/       — SPA Vue (carte Leaflet)
  scripts/   — indexer, enricher, migrate
```

## Scripts utiles

```bash
# Indexation Wikipedia
npm run indexer -w @strabon/scripts

# Enrichissement Wikidata
npm run enricher -w @strabon/scripts

# Migration JSON → PostgreSQL
npm run migrate -w @strabon/scripts -- --file /path/to/index.json
```
