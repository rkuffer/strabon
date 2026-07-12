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
  getFiliationContext,
  normalizeTimelineV2,
  isRejection,
  isEmptyTimeline,
  getCountryInfo,
} from "../../agent/extract-v2.js";
import { validateTimelineQids } from "../../agent/validate-timeline.js";
import { recordGaps } from "../../agent/referential-gaps.js";
import {
  recordPromptVersion,
  recordRun,
  confirmRun,
  referentialHash,
} from "../../agent/run-history.js";
import { EXTRACTION_PROMPT_TEMPLATE } from "../../agent/extract-v2.js";

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
    console.error(
      `[extract] JSON.parse failed: ${(parseErr as Error).message}`,
    );
    console.error(`[extract] raw response (${raw.length} chars):\n${raw}`);
    throw new SyntaxError("Invalid JSON from model");
  }

  const timeline = normalizeTimelineV2(parsed);
  return { raw, timeline };
}

// ── Extraction complète pour un site (partagée run + batch) ──────────────────

type ExtractOutcome =
  | {
      kind: "ok";
      timeline: any;
      raw: string;
      localLang: string | null;
      violations: number;
      /** Row id in site_extractions — lets /confirm flag the human's verdict. */
      runId: number | null;
    }
  | { kind: "rejected"; reason: string; runId: number | null }
  | { kind: "no_content" }
  | { kind: "empty"; runId: number | null };

async function extractSite(
  sql: any,
  site: any,
  client: Anthropic,
  refs: Awaited<ReturnType<typeof loadReferentials>>,
): Promise<ExtractOutcome> {
  // 1. Wikipedia context (with resolved country name for local-language lookup)
  const { name: countryName, langCode } = await getCountryInfo(
    sql,
    site.country_qid,
  );
  const wikiContext = await buildWikipediaContext(
    site.wikidata_id,
    countryName,
    site.title_en,
    client,
    ROUTER_MODEL,
    langCode,
  );

  if (!wikiContext.en && !wikiContext.local) {
    return { kind: "no_content" };
  }
  if (!wikiContext.en) {
    console.warn(
      `[extract] ⚠ contenu EN vide — extraction basée uniquement sur ${wikiContext.localLang}`,
    );
  }

  // 2. Prompt + LLM
  const filiation = getFiliationContext(site);
  const prompt = buildPromptV2(site.title_en, wikiContext, refs, filiation);
  console.log(`[extract] prompt: ${prompt.length} chars → ${MODEL}`);

  // Archive the prompt TEMPLATE (markers unsubstituted) if we have not seen this
  // version before. The repo stays the source of truth; this is a log of what
  // actually ran — the way a deployment log records what was shipped.
  const promptHash = await recordPromptVersion(
    sql,
    "extraction",
    EXTRACTION_PROMPT_TEMPLATE,
  );
  const refHash = referentialHash(refs);

  const t = Date.now();
  const { raw, timeline } = await callClaude(prompt);
  console.log(`[extract] ✓ LLM en ${Date.now() - t}ms`);

  // 3. Rejection (non-site detected by the model)
  const rejection = isRejection(timeline);
  if (rejection.rejected) {
    // Recorded too: a rejection is a run, and a sample of the model's behaviour.
    const runId = await recordRun(sql, {
      siteId: site.id,
      timeline,
      model: MODEL,
      promptHash,
      referentialHash: refHash,
      localLang: wikiContext.localLang || null,
      rejected: true,
      rejectionReason: rejection.reason ?? "non-site",
    });
    return { kind: "rejected", reason: rejection.reason ?? "non-site", runId };
  }

  // 4. Empty timeline (nothing extractable)
  if (isEmptyTimeline(timeline)) {
    const runId = await recordRun(sql, {
      siteId: site.id,
      timeline,
      model: MODEL,
      promptHash,
      referentialHash: refHash,
      localLang: wikiContext.localLang || null,
      rejected: true,
      rejectionReason: "empty timeline",
    });
    return { kind: "empty", runId };
  }

  // 5. Deterministic QID validation (strips cross-track reuse + invented QIDs)
  const { timeline: validated, violations } = await validateTimelineQids(
    sql,
    timeline,
  );
  if (violations.length) {
    console.warn(`[extract] ${violations.length} QID violation(s) stripped:`);
    for (const v of violations) {
      console.warn(`  ✗ ${v.track} "${v.name}" (${v.qid}): ${v.reason}`);
    }
  }

  // 6. Record the run — the WHOLE point of doing it here, in the one place where
  //    the prompt is built: /run and /stream are both covered, with no duplicated
  //    logic and no path that can silently forget to record.
  //
  //    Previews are recorded too. Today's three London runs were all previews, and
  //    they are exactly the corpus we need. Only /confirm sets `confirmed`.
  const runId = await recordRun(sql, {
    siteId: site.id,
    timeline: validated,
    model: MODEL,
    promptHash,
    referentialHash: refHash,
    localLang: wikiContext.localLang || null,
    qidViolations: violations.length,
  });

  return {
    kind: "ok",
    timeline: validated,
    raw,
    localLang: wikiContext.localLang || null,
    violations: violations.length,
    runId,
  };
}

/**
 * Recompute inception/dissolution from the timeline, which is AUTHORITATIVE.
 *
 * A null result is a RESULT, not an absence of opinion: it means "the timeline shows
 * no dissolution", i.e. the site is still alive. It MUST overwrite any stale value
 * inherited from Wikidata (P571/P576).
 *
 * The previous COALESCE-based version preserved the old value on null, which left
 * Bordeaux with dissolution_year = 1804 (a Wikidata artefact) — making a living city
 * invisible on the map after 1804. Never COALESCE here.
 */
async function updateTemporalBounds(
  sql: any,
  siteId: string,
  timeline: SiteTimeline,
) {
  const inception = computeInceptionFromTimeline(timeline);
  const dissolution = computeDissolutionFromTimeline(timeline);

  await sql`
    UPDATE sites SET
      inception_year   = ${inception},
      dissolution_year = ${dissolution}
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

  // POST /admin/extract/:id/run — déclenche l'extraction LLM (preview, pas d'écriture)
  app.post<{ Params: { id: string } }>(
    "/admin/extract/:id/run",
    async (req, reply) => {
      const site = (await getSiteById(req.params.id)) as any;
      if (!site) return reply.status(404).send({ error: "Site not found" });

      const sql = getSql();

      try {
        const client = getClient();
        console.log(`[extract] ▶ ${site.title_en} (${site.wikidata_id})`);

        const refs = await loadReferentials(sql);
        const outcome = await extractSite(sql, site, client, refs);

        if (outcome.kind === "no_content") {
          return reply
            .status(400)
            .send({ error: "Could not fetch Wikipedia content" });
        }
        if (outcome.kind === "rejected") {
          return reply.status(200).send({
            site_id: site.id,
            title: site.title_en,
            rejected: true,
            reason: outcome.reason,
          });
        }
        if (outcome.kind === "empty") {
          return reply.status(200).send({
            site_id: site.id,
            title: site.title_en,
            rejected: true,
            reason: "empty timeline — no extractable content",
          });
        }

        return reply.send({
          site_id: site.id,
          title: site.title_en,
          timeline: outcome.timeline,
          raw: outcome.raw,
          model: MODEL,
          router_model: ROUTER_MODEL,
          local_lang: outcome.localLang,
          qid_violations: outcome.violations,
          // The client echoes this back on /confirm so we can flag the run as
          // human-validated. Optional: without it the run is still recorded, only
          // the verdict is lost.
          run_id: outcome.runId,
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
    Body: {
      timeline: SiteTimeline;
      model?: string;
      extracted_at?: string;
      /** Row id returned by /run — flags that run as human-validated. */
      run_id?: number | null;
    };
  }>("/admin/extract/:id/confirm", async (req, reply) => {
    const { timeline, model, extracted_at, run_id } = req.body;
    const { id } = req.params;

    if (!timeline)
      return reply.status(400).send({ error: "timeline required" });

    const sql = getSql();

    // Re-validate on confirm (defensive: the client could have altered it)
    const { timeline: validated, violations } = await validateTimelineQids(
      sql,
      timeline,
    );

    await sql`
      UPDATE sites SET
        timeline                  = ${sql.json(validated)},
        timeline_extracted_at     = ${extracted_at ?? new Date().toISOString()},
        timeline_extraction_model = ${model ?? MODEL},
        enrichment_level          = 'extracted',
        last_updated              = now()
      WHERE id = ${id}
    `;

    const { polities, cultures } =
      await syncReferentialsFromTimeline(validated);
    await updateTemporalBounds(sql, id, validated);

    // Record referential gaps signaled by this extraction
    const gaps = await recordGaps(
      sql,
      id,
      (validated as any).missing_entities,
      validated,
    );

    // The run itself was already recorded by /run — we only stamp the verdict.
    if (run_id) await confirmRun(sql, run_id);

    return reply.send({
      ok: true,
      polities_added: polities,
      cultures_added: cultures,
      gaps_recorded: gaps,
      qid_violations: violations.length,
    });
  });

  // GET /admin/extract/stream?ids=... — SSE extraction batch
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
        errors = 0,
        excluded = 0;

      // Load referentials ONCE before the loop (5400+ entries — expensive)
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

          const outcome = await extractSite(sql, site, client, refs);

          // Exclusion cases — mark and move on
          if (
            outcome.kind === "no_content" ||
            outcome.kind === "rejected" ||
            outcome.kind === "empty"
          ) {
            const reason =
              outcome.kind === "rejected"
                ? outcome.reason
                : outcome.kind === "empty"
                  ? "empty timeline — no extractable content"
                  : "no Wikipedia content";

            await sql`
              UPDATE sites SET
                enrichment_level = 'excluded',
                last_updated = now()
              WHERE id = ${id}
            `;
            excluded++;
            console.log(
              `[extract:batch] ⊘ ${site.title_en} excluded: ${reason}`,
            );
            send("done_one", {
              id,
              title: site.title_en,
              ok: false,
              excluded: true,
              reason,
            });
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }

          // Success — write timeline
          await sql`
            UPDATE sites SET
              timeline                  = ${sql.json(outcome.timeline)},
              timeline_extracted_at     = now(),
              timeline_extraction_model = ${MODEL},
              enrichment_level          = 'extracted',
              last_updated              = now()
            WHERE id = ${id}
          `;

          await syncReferentialsFromTimeline(outcome.timeline);
          await updateTemporalBounds(sql, id, outcome.timeline);

          const gaps = await recordGaps(
            sql,
            id,
            outcome.timeline.missing_entities,
            outcome.timeline,
          );

          // A batch run IS written to sites.timeline, so it is confirmed de facto —
          // no human ever looked at it, but it is the timeline in production.
          if (outcome.runId) await confirmRun(sql, outcome.runId);

          done++;
          send("done_one", {
            id,
            title: site.title_en,
            ok: true,
            local_lang: outcome.localLang,
            gaps_recorded: gaps,
            qid_violations: outcome.violations,
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

      send("done", { done, errors, excluded, total: ids.length });
      reply.raw.end();
    },
  );
};
