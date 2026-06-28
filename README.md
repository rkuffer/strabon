# Strabon 2

Atlas temporel pan-historique des sites archéologiques et villes historiques,
sur ~12 000 ans. Chaque site porte des pistes temporelles indépendantes
(polity, culture, type de site, nom, population) et des événements ponctuels,
rendus sur une carte interactive avec des polygones d'emprise (hulls) pour les
étendues de polities et de cultures.

> ⚠️ **Work in progress / expérimental.** La conception évolue ; certaines
> parties (extraction, référentiels) sont en cours de refonte.

## Stack

- **Backend** : Fastify 5 + templates Eta + PostgreSQL/PostGIS
- **Frontend SPA** : Vue 3 + Vite + PrimeVue + TanStack Query + Leaflet
- **DB** : postgres.js (SQL brut, pas d'ORM)
- **Shared** : types TypeScript + utilitaires timeline partagés
- **Extraction** : SDK Anthropic (timeline depuis Wikipédia/Wikidata)

## Structure

```
packages/
  shared/    — Types TypeScript + utils timeline partagés
  db/        — Client PostgreSQL + requêtes SQL + schéma
  server/    — API Fastify + pages HTML (Eta) + routes admin
  web/       — SPA Vue (carte Leaflet)
  scripts/   — ingestion référentiel, indexer, enricher
```

## Démarrage rapide

```bash
# 1. Configuration
cp .env.example .env
# Éditer DATABASE_URL dans .env

# 2. Base de données (crée toutes les tables, dont le référentiel Wikidata)
psql -U postgres -c "CREATE DATABASE strabon;"
psql -U postgres -d strabon -f packages/db/src/schema.sql

# 3. Dépendances
npm install

# 4. Référentiel d'autorité Wikidata (polities + cultures)
#    Peuple wikidata_entities depuis query.wikidata.org (~5 200 entités).
DATABASE_URL="postgres://strabon:strabon@localhost:5432/strabon" \
  npx tsx packages/scripts/src/ingest-referential.ts

# 5. Lancer en développement (Fastify :3000 + Vite :5173)
npm run dev
```

## Référentiel d'autorité Wikidata

La table `wikidata_entities` est un corpus de recherche fiable (QID canoniques,
labels, alias, descriptions) dans lequel on résout les entités politiques et
culturelles. Elle remplace la résolution de QID auparavant déléguée au LLM, qui
produisait des identifiants erronés. Réingestion idempotente via le script de
l'étape 4 (INSERT pour les nouveaux QID, UPDATE des libellés pour les existants).

Outil de recherche en CLI :

```bash
DATABASE_URL=... npx tsx packages/scripts/src/lookup-entity.ts "Roman Republic"
DATABASE_URL=... npx tsx packages/scripts/src/lookup-entity.ts "Shang" --kind=culture
```

## Scripts

```bash
# Ingestion / mise à jour du référentiel d'autorité Wikidata
npx tsx packages/scripts/src/ingest-referential.ts

# Indexation Wikipédia (crawl de catégories)
npm run indexer -w @strabon/scripts

# Enrichissement Wikidata
npm run enricher -w @strabon/scripts
```

> Note : d'anciens scripts (`migrate.ts`, `update-timeline.ts`) sont hérités du
> premier prototype basé sur `index.json` et sont en voie de suppression.
