// packages/server/src/routes/admin/extract.ts
import type { FastifyPluginAsync } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { getSql, getSiteById, syncReferentialsFromTimeline } from "@strabon/db";
import {
  computeInceptionFromTimeline,
  computeDissolutionFromTimeline,
} from "@strabon/shared";
import type { SiteTimeline } from "@strabon/shared";
import { buildWikipediaContext } from "./wikipedia.js";
import {
  loadReferentials,
  buildPromptV2,
  getCountryName,
  getFiliationContext,
  normalizeTimelineV2,
  isRejection,
  isEmptyTimeline,
} from "../../agent/extract-v2.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const ROUTER_MODEL =
  process.env.ANTHROPIC_ROUTER_MODEL ?? "claude-haiku-4-5-20251001";

// ── Client Anthropic ──────────────────────────────────────────────────────────

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");
  return new Anthropic({ apiKey });
}

// ── Appel Claude via SDK ──────────────────────────────────────────────────────

async function callClaude(
  prompt: string,
): Promise<{ raw: string; timeline: any }> {
  const client = getClient();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  let parsed: any;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error(`[extract] JSON.parse failed`);
    console.error(`[extract] error:`, (parseErr as Error).message);
    console.error(
      `[extract] raw model response (${raw.length} chars):\n${raw}`,
    );
    throw new SyntaxError("Invalid JSON from model");
  }

  const timeline = normalizeTimelineV2(parsed);
  return { raw, timeline };
}

// ── Mise à jour des bornes temporelles ───────────────────────────────────────

async function updateTemporalBounds(
  sql: any,
  siteId: string,
  timeline: SiteTimeline,
) {
  const inception = computeInceptionFromTimeline(timeline);
  const dissolution = computeDissolutionFromTimeline(timeline);
  if (inception === null && dissolution === null) return;
  await sql`
    UPDATE sites SET
      inception_year   = COALESCE(${inception},   inception_year),
      dissolution_year = COALESCE(${dissolution}, dissolution_year)
    WHERE id = ${siteId}
  `;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const adminExtractRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/extract — liste des sites
  app.get<{
    Querystring: { q?: string; status?: string };
  }>("/admin/extract", async (req, reply) => {
    const sql = getSql();
    const { q, status = "queued" } = req.query;

    const sites = await sql.unsafe(`
        SELECT id, title_en, country, base_importance,
               timeline IS NOT NULL AS has_timeline,
               timeline_extracted_at,
               timeline_extraction_model
        FROM sites
        WHERE location IS NOT NULL
          ${q ? `AND title_en ILIKE '%${q.replace(/'/g, "''")}%'` : ""}
          ${status === "queued" ? "AND enrichment_level = 'queued'" : ""}
          ${status === "no_timeline" ? "AND timeline IS NULL" : ""}
          ${status === "has_timeline" ? "AND timeline IS NOT NULL" : ""}
        ORDER BY base_importance DESC, title_en
        LIMIT 200
      `);

    return reply.view("admin/extract/list", {
      title: "Extraction LLM — Admin",
      sites,
      status,
      q,
    });
  });

  // GET /admin/extract/:id — page extraction unitaire avec preview
  app.get<{ Params: { id: string } }>(
    "/admin/extract/:id",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site)
        return reply.status(404).view("errors/404", { title: "Not found" });

      const { Eta } = await import("eta");
      const nodePath = await import("path");
      const { fileURLToPath } = await import("url");
      const __dir = nodePath.dirname(fileURLToPath(import.meta.url));
      const viewsRoot = nodePath.join(__dir, "../../../views");
      const renderer = new Eta({ views: viewsRoot });
      const html = await renderer.renderAsync("admin/extract/preview", {
        title: `Extraction — ${site.title_en}`,
        site,
        viteDev: process.env.NODE_ENV !== "production",
      });
      return reply.type("text/html").send(html);
    },
  );

  // POST /admin/extract/:id/run — déclenche l'extraction LLM (V2)
  app.post<{ Params: { id: string } }>(
    "/admin/extract/:id/run",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site) return reply.status(404).send({ error: "Site not found" });

      const sql = getSql();

      try {
        const client = getClient();

        console.log(
          `[extract] ▶ ${site.title_en} (${site.wikidata_id})`,
        );
        const t0 = Date.now();
        const countryName = await getCountryName(sql, site.country_qid);
        const wikiContext = await buildWikipediaContext(
          site.wikidata_id,
          countryName,
          site.title_en,
          client,
          ROUTER_MODEL,
        );

        if (!wikiContext.en && !wikiContext.local) {
          return reply
            .status(400)
            .send({ error: "Could not fetch Wikipedia content" });
        }
        if (!wikiContext.en) {
          console.warn(
            `[extract] ⚠ contenu EN vide pour ${site.title_en} — extraction basée uniquement sur la langue locale (${wikiContext.localLang})`,
          );
        }
        console.log(`[extract] ✓ Wikipedia en ${Date.now() - t0}ms`);

        const refs = await loadReferentials(sql);
        const filiation = getFiliationContext(site);
        const prompt = buildPromptV2(
          site.title_en,
          wikiContext,
          refs,
          filiation,
        );
        console.log(
          `[extract] prompt: ${prompt.length} chars → appel ${MODEL}`,
        );
        const t1 = Date.now();
        const { raw, timeline } = await callClaude(prompt);
        console.log(
          `[extract] ✓ LLM en ${Date.now() - t1}ms — ${raw.length} chars retournés`,
        );

        return reply.send({
          site_id: site.id,
          title: site.title_en,
          timeline,
          raw,
          model: MODEL,
          router_model: ROUTER_MODEL,
          local_lang: wikiContext.localLang || null,
          extracted_at: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError)
          return reply
            .status(401)
            .send({ error: "ANTHROPIC_API_KEY invalide" });
        if (err instanceof Anthropic.RateLimitError)
          return reply.status(429).send({
            error: "Rate limit Anthropic — réessayer dans quelques secondes",
          });
        if (err instanceof Anthropic.APIError)
          return reply
            .status(502)
            .send({ error: `Anthropic API: ${(err as any).message}` });
        if (err instanceof SyntaxError)
          return reply
            .status(422)
            .send({ error: "Le modèle n'a pas retourné du JSON valide" });
        throw err;
      }
    },
  );

  // POST /admin/extract/:id/confirm — valide et écrit en base
  app.post<{
    Params: { id: string };
    Body: { timeline: SiteTimeline; model?: string; extracted_at?: string };
  }>("/admin/extract/:id/confirm", async (req, reply) => {
    const { timeline, model, extracted_at } = req.body;
    const { id } = req.params;

    if (!timeline)
      return reply.status(400).send({ error: "timeline required" });

    const sql = getSql();
    await sql`
      UPDATE sites SET
        timeline                  = ${sql.json(timeline)},
        timeline_extracted_at     = ${extracted_at ?? new Date().toISOString()},
        timeline_extraction_model = ${model ?? MODEL},
        enrichment_level          = 'extracted',
        last_updated              = now()
      WHERE id = ${id}
    `;

    const { polities, cultures } = await syncReferentialsFromTimeline(timeline);
    await updateTemporalBounds(sql, id, timeline);

    return reply.send({
      ok: true,
      polities_added: polities,
      cultures_added: cultures,
    });
  });

  // GET /admin/extract/stream?ids=... — SSE extraction batch (V2)
  app.get<{ Querystring: { ids: string } }>(
    "/admin/extract/stream",
    async (req, reply) => {
      const ids = req.query.ids?.split(",").filter(Boolean) ?? [];
      if (!ids.length) return reply.status(400).send({ error: "ids required" });

      try {
        getClient();
      } catch {
        return reply.status(500).send({ error: "ANTHROPIC_API_KEY not set" });
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders?.();

      const send = (event: string, data: object) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const client = getClient();
      const sql = getSql();
      let done = 0,
        errors = 0;

      // Load referentials ONCE before the loop (5400+ entries, expensive)
      const refs = await loadReferentials(sql);

      send("start", { total: ids.length });

      for (const id of ids) {
        const site = (await getSiteById(id)) as any;
        if (!site) {
          errors++;
          send("error", { id, message: "Site introuvable" });
          continue;
        }

        send("processing", { id, title: site.title_en });

        try {
          console.log(
            `[extract:batch] ▶ ${site.title_en} (${site.wikidata_id})`,
          );
          const bt0 = Date.now();
          const countryName = await getCountryName(sql, site.country_qid);
          const wikiContext = await buildWikipediaContext(
            site.wikidata_id,
            countryName,
            site.title_en,
            client,
            ROUTER_MODEL,
          );

          if (!wikiContext.en && !wikiContext.local) {
            // No Wikipedia content → exclude
            await sql`UPDATE sites SET enrichment_level = 'excluded' WHERE id = ${id}`;
            send("done_one", {
              id,
              title: site.title_en,
              ok: false,
              reason: "no_content",
            });
            done++;
            continue;
          }

          if (!wikiContext.en) {
            console.warn(
              `[extract:batch] ⚠ contenu EN vide — extraction basée uniquement sur ${wikiContext.localLang}`,
            );
          }
          console.log(
            `[extract:batch] ✓ Wikipedia en ${Date.now() - bt0}ms — local: ${wikiContext.localLang || "none"}`,
          );

          const filiation = getFiliationContext(site);
          const prompt = buildPromptV2(
            site.title_en,
            wikiContext,
            refs,
            filiation,
          );
          console.log(
            `[extract:batch] prompt: ${prompt.length} chars → appel ${MODEL}`,
          );
          const bt1 = Date.now();
          const { timeline } = await callClaude(prompt);
          console.log(`[extract:batch] ✓ LLM en ${Date.now() - bt1}ms`);

          // Check for rejection (non-site detected by LLM)
          const rejection = isRejection(timeline);
          if (rejection.rejected) {
            await sql`UPDATE sites SET enrichment_level = 'excluded' WHERE id = ${id}`;
            send("done_one", {
              id,
              title: site.title_en,
              ok: false,
              reason: rejection.reason,
            });
            done++;
            continue;
          }

          // Check for empty timeline (no extractable content)
          if (isEmptyTimeline(timeline)) {
            await sql`UPDATE sites SET enrichment_level = 'excluded' WHERE id = ${id}`;
            send("done_one", {
              id,
              title: site.title_en,
              ok: false,
              reason: "empty_timeline",
            });
            done++;
            continue;
          }

          // Success — write timeline
          await sql`
            UPDATE sites SET
              timeline                  = ${sql.json(timeline)},
              timeline_extracted_at     = now(),
              timeline_extraction_model = ${MODEL},
              enrichment_level          = 'extracted',
              last_updated              = now()
            WHERE id = ${id}
          `;

          await syncReferentialsFromTimeline(timeline);
          await updateTemporalBounds(sql, id, timeline);
          done++;
          send("done_one", {
            id,
            title: site.title_en,
            ok: true,
            local_lang: wikiContext.localLang || null,
          });
        } catch (err: any) {
          errors++;
          const msg =
            err instanceof Anthropic.RateLimitError
              ? "Rate limit — attente forcée"
              : err instanceof Anthropic.APIError
                ? `Anthropic: ${err.message}`
                : err.message;
          send("error", { id, title: site.title_en, message: msg });

          if (err instanceof Anthropic.RateLimitError) {
            await new Promise((r) => setTimeout(r, 10000));
            continue;
          }
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      send("done", { done, errors, total: ids.length });
      reply.raw.end();
    },
  );
};
