// packages/server/src/routes/admin/extract.ts
import type { FastifyPluginAsync } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import {
  getSql,
  getSiteById,
  syncReferentialsFromTimeline,
  loadEntityBounds,
  recordBoundsConflicts,
} from "@strabon/db";
import {
  computeInceptionFromTimeline,
  computeDissolutionFromTimeline,
  applyEntityBounds,
} from "@strabon/shared";
import type { SiteTimeline, BoundsConflict } from "@strabon/shared";
import { buildWikipediaContext } from "./wikipedia.js";
import {
  loadReferentials,
  buildPromptV2,
  getFiliationContext,
  getAttributionsContext,
  normalizeTimelineV2,
  isRejection,
  isEmptyTimeline,
  getCountryInfo,
} from "../../agent/extract-v2.js";
import { validateTimelineQids } from "../../agent/validate-timeline.js";
import { recordGaps } from "@strabon/db";
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

async function callClaude(prompt: {
  cachedPrefix: string;
  siteBlock: string;
}): Promise<{ raw: string; timeline: any }> {
  const client = getClient();

  // Stream and accumulate rather than a blocking create: with a 32000-token cap
  // the SDK refuses a NON-streaming call (its worst-case-time estimate exceeds the
  // 10-minute non-streaming ceiling) and requires streaming. finalMessage()
  // returns the same Message shape (content, stop_reason, usage), so nothing
  // downstream changes.
  //
  // Two content blocks with a cache breakpoint on the first: the static prefix
  // (instructions + full referential) is the dominant share of the input and is
  // byte-identical across sites, so it is written to cache once and then read at
  // 10% of the input price for every later call within the TTL. The per-site block
  // (site identity, priors, Wikipedia sources) follows the breakpoint and is never
  // cached. Ordering matters: everything BEFORE the marked block is what gets
  // cached, so the site block must come second.
  const message = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 32000,
      // Sonnet 5 runs adaptive thinking BY DEFAULT, and thinking tokens count
      // against max_tokens — so on a rich site they eat the budget and the JSON is
      // truncated (this pipeline was built for Sonnet 4.6, which never thought).
      // Extraction is a prescriptive structured-transform task, not a reasoning
      // one: disabling thinking hands the whole budget back to the response and
      // keeps cost/latency down. No-op on models that don't think by default.
      // (To A/B *with* thinking for quality, enable it and raise max_tokens so both
      //  the thinking and the JSON fit.)
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt.cachedPrefix,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: prompt.siteBlock },
          ],
        },
      ],
    })
    .finalMessage();

  // Cache observability: without this there is no way to tell a hit from a miss.
  // Expect created>0 / read=0 on the first call of a run, then created=0 / read>0.
  // If read stays 0 across a run, the prefix is not byte-stable (or the TTL lapsed
  // between sites) — that is the signal to investigate, not a silent cost.
  const u: any = message.usage ?? {};
  console.log(
    `[extract] tokens: cache_created=${u.cache_creation_input_tokens ?? 0} ` +
      `cache_read=${u.cache_read_input_tokens ?? 0} ` +
      `uncached_input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0}`,
  );

  // A truncated response is NOT malformed JSON — it's an incomplete one. Detect it
  // explicitly so the failure reads "truncated, raise max_tokens" instead of the
  // misleading "Invalid JSON", and so a partial timeline is never parsed/accepted.
  if (message.stop_reason === "max_tokens") {
    console.error(
      `[extract] output truncated at max_tokens (${message.usage?.output_tokens ?? "?"} output tokens) — raise max_tokens`,
    );
    throw new Error(
      "Model output truncated (hit max_tokens) — response incomplete, raise max_tokens",
    );
  }

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
      /**
       * Entity-bound conflicts — RETURNED, never recorded here.
       *
       * extractSite() is called by /run, which is a PREVIEW and must not touch the
       * database. recordBoundsConflicts() deletes the site's existing conflicts
       * before inserting, so calling it from a preview would wipe the real ones on
       * behalf of a timeline nobody ever confirmed. Only the WRITE paths persist.
       */
      conflicts: BoundsConflict[];
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

  // Cultural attributions (Wikidata P2596) as a per-site classification prior.
  // `active` gate: never re-inject a culture invalidated in the referential.
  // Bounds are deliberately NOT injected — the model dates from the sources.
  const attributionRows = await sql`
    SELECT we.label_en, a.entity_qid
    FROM site_attributions a
    JOIN wikidata_entities we ON we.qid = a.entity_qid
    WHERE a.site_id = ${site.id}
      AND a.kind = 'culture'
      AND we.active
    ORDER BY we.label_en
  `;
  const attributions = getAttributionsContext(
    attributionRows as { label_en: string; entity_qid: string }[],
  );

  const prompt = buildPromptV2(
    site.title_en,
    wikiContext,
    refs,
    filiation,
    attributions,
  );
  console.log(
    `[extract] prompt: ${prompt.full.length} chars ` +
      `(cached prefix ${prompt.cachedPrefix.length} / per-site ${prompt.siteBlock.length}) → ${MODEL}`,
  );

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

  // 6. Entity chronological bounds — the only DETERMINISTIC guard against the
  //    infinite tails of step tracks.
  //
  //    Runs AFTER QID validation, and the order matters: validation strips the
  //    invented and cross-track-reused QIDs, and an entry without a QID has no
  //    entity to look up. Bounding first would bind entries to QIDs that
  //    validation is about to tear off.
  //
  //    A bound is a CEILING, never a truth: applyEntityBounds closes and shortens,
  //    but NEVER deletes. Irreconcilable entries are returned as conflicts and left
  //    untouched — a wrong entry that is VISIBLE can be curated, a deleted one is a
  //    silent hole.
  const bounds = await loadEntityBounds();
  const { timeline: bounded, conflicts } = applyEntityBounds(validated, bounds);

  const hardConflicts = conflicts.filter((c) => c.action === "incompatible");
  if (hardConflicts.length) {
    console.warn(
      `[extract] ${hardConflicts.length} bound conflict(s) — left untouched, for review:`,
    );
    for (const c of hardConflicts) {
      console.warn(`  ⚠ ${c.track} "${c.entity_label}": ${c.detail}`);
    }
  }

  // 7. Record the run — the WHOLE point of doing it here, in the one place where
  //    the prompt is built: /run and /stream are both covered, with no duplicated
  //    logic and no path that can silently forget to record.
  //
  //    Previews are recorded too. Today's three London runs were all previews, and
  //    they are exactly the corpus we need. Only /confirm sets `confirmed`.
  //
  //    We archive the BOUNDED timeline: it is what the pipeline actually produces,
  //    and it is what would go to production. The pre-bound version survives
  //    nowhere else — but nothing is lost, because bounds only close and shorten.
  const runId = await recordRun(sql, {
    siteId: site.id,
    timeline: bounded,
    model: MODEL,
    promptHash,
    referentialHash: refHash,
    localLang: wikiContext.localLang || null,
    qidViolations: violations.length,
  });

  return {
    kind: "ok",
    timeline: bounded,
    raw,
    localLang: wikiContext.localLang || null,
    violations: violations.length,
    conflicts,
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

  // POST /admin/extract/:id/exclude — exclusion manuelle (ex. homonyme repéré
  // avant/sans lancer l'extraction LLM). Marque enrichment_level='excluded'
  // directement, sans appel LLM ni condition sur l'état actuel du site.
  app.post<{ Params: { id: string } }>(
    "/admin/extract/:id/exclude",
    async (req, reply) => {
      const sql = getSql();
      const rows = await sql`
        UPDATE sites SET
          enrichment_level = 'excluded',
          last_updated = now()
        WHERE id = ${req.params.id}
        RETURNING id, title_en
      `;
      if (!rows.length)
        return reply.status(404).send({ error: "Site not found" });

      console.log(`[extract] ⊘ ${rows[0].title_en} exclu manuellement`);
      return reply.send({ ok: true, id: rows[0].id });
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
          // Shown, not stored: /run is a preview. The human sees which entries the
          // bounds could not reconcile BEFORE deciding to confirm.
          bounds_conflicts: outcome.conflicts.filter(
            (c) => c.action === "incompatible",
          ),
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

    // /confirm is a WRITE path, and the client can have edited the JSON by hand.
    // It must therefore apply EVERY rule /run applies — normalisation included.
    // Until now it only re-validated QIDs, so a hand-edited timeline entered
    // production unnormalised: `to` on a name track, mis-typed events, unbounded
    // step tracks. Same pipeline, same order, no exceptions.
    const normalized = normalizeTimelineV2(timeline);

    const { timeline: validated, violations } = await validateTimelineQids(
      sql,
      normalized,
    );

    const bounds = await loadEntityBounds();
    const { timeline: bounded, conflicts } = applyEntityBounds(
      validated,
      bounds,
    );

    await sql`
      UPDATE sites SET
        timeline                  = ${sql.json(bounded)},
        timeline_extracted_at     = ${extracted_at ?? new Date().toISOString()},
        timeline_extraction_model = ${model ?? MODEL},
        enrichment_level          = 'extracted',
        last_updated              = now()
      WHERE id = ${id}
    `;

    const { polities, cultures } = await syncReferentialsFromTimeline(bounded);
    await updateTemporalBounds(sql, id, bounded);

    // Record referential gaps signaled by this extraction
    const gaps = await recordGaps(
      sql,
      id,
      (bounded as any).missing_entities,
      bounded,
    );

    // Irreconcilable entries — the ONLY ones a human must arbitrate. This is a
    // WRITE path, so here they are persisted.
    const boundsConflicts = await recordBoundsConflicts(id, conflicts);

    // The run itself was already recorded by /run — we only stamp the verdict.
    if (run_id) await confirmRun(sql, run_id);

    return reply.send({
      ok: true,
      polities_added: polities,
      cultures_added: cultures,
      gaps_recorded: gaps,
      qid_violations: violations.length,
      bounds_conflicts: boundsConflicts,
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

          // Success — write timeline (already bounded by extractSite)
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

          // A batch run IS written to sites.timeline — a write path, so the bound
          // conflicts are persisted here too.
          const boundsConflicts = await recordBoundsConflicts(
            id,
            outcome.conflicts,
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
            bounds_conflicts: boundsConflicts,
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
