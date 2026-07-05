// packages/server/src/agent/discovery-agent.ts
// =============================================================================
// Discovery agent — turns a user request into a PROPOSED list of site candidates.
//
// Contract:
//   discoverCandidates(request) → { proposals, ... }
//   - The agent READS (search + inspect + dedup) and JUDGES (filters noise).
//   - It never writes. It proposes a list; the human selects (checkbox view);
//     validation writes the checked ones into site_candidates.
//   - Terminal tool `submit_candidates` ends the loop.
//
// First iteration handles PRECISE / SEMI-PRECISE requests ("Marseille",
// "Beyrouth", "Aşıklı Höyük") via multilingual name search (EN + FR). The VAGUE
// mode (class/region/period SPARQL exploration) comes later, as an added tool.
//
// Core value: NOISE FILTERING. Wiki* search returns a jumble (buildings, orgs,
// local products, homonyms). The agent keeps only what plausibly IS an
// inhabited/localizable place relevant to the atlas. Bias = WIDE RECALL: when
// in doubt, KEEP and propose — the human filters by (un)checking.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import {
  searchWikidataSites,
  getWikidataEntity,
  checkSiteExists,
} from "./resolution-tools.js";

const MODEL = process.env.ANTHROPIC_DISCOVERY_MODEL ?? "claude-sonnet-4-6";
const MAX_TURNS = 12;

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateProposal = {
  qid: string;
  label: string;
  description: string | null;
  type: string | null;              // short type hint (e.g. "archaeological site")
  lat?: number | null;
  lon?: number | null;
  already_in_base: boolean;         // → greyed out / non-selectable in the view
  existing_title?: string | null;   // if already_in_base
};

export type DiscoveryResult = {
  request: string;
  proposals: CandidateProposal[];
  reasoning: string;                // why this set (what was kept / filtered)
  turns: number;
  tool_calls: string[];
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Discovery agent of Strabon, a pan-historical world atlas of inhabited places across ~12,000 years.

# Mission
You receive a user request naming or describing place(s) they want to add to the atlas. Produce a PROPOSED LIST of candidate places for the human to review and select from. You do not add anything yourself — you propose; the human picks.

# What counts as a candidate
A candidate is a LOCALIZABLE INHABITED PLACE relevant to the atlas: a city, town, village, ancient city, archaeological site, tell/höyük, settlement — of ANY period, from Neolithic to modern. Do NOT restrict to archaeological sites.

# Your core job: FILTER THE NOISE
Wikidata search returns a jumble. For a query, results routinely include non-places that merely share the name: buildings, monuments, organizations, sports clubs, companies, local products/dishes, people, artworks, events, administrative abstractions. DISCARD those. Keep only entries that plausibly ARE inhabited/localizable places.

When a result's nature is unclear from its description and types, inspect it with get_wikidata_entity before deciding.

# Bias: WIDE RECALL
The human makes the final selection via checkboxes, so err toward INCLUDING. Discard only CLEARLY non-place noise. When genuinely in doubt whether something is a relevant place, KEEP it and propose it — the human will simply not check it. Missing a real place (it never appears) is worse than proposing a doubtful one (one unchecked box).

# Method
1. Search with search_wikidata_sites. Search in BOTH English and French (call it once per language) and merge — the user may use a French place name ("Beyrouth" → Beirut). Deduplicate by QID.
   Search is a NAME match: keep queries short. If a precise request returns only wrong-kind results, try a short variant (native-language name, e.g. "höyük"/"tell" for an ancient mound) — but never add descriptive qualifiers, they aren't in labels.
2. For each surviving candidate, judge from its description + P31 types whether it is a place. Inspect doubtful ones with get_wikidata_entity.
3. For every candidate you keep, call check_site_exists to flag whether it is already in the atlas (already_in_base = true). Keep already-present ones in the list (the view shows them greyed, for the human's information) — do not silently drop them.
4. Submit the full proposed list with submit_candidates.

# Hard rules
- You never write to the database. You only propose.
- Every candidate needs a QID (Wikidata is the authority; no QID = not a candidate).
- reasoning is ALWAYS required: say what you searched, what you kept, and what noise you discarded.

# Efficiency
Search both languages, filter, dedup-check, submit. Don't re-fetch what you already have. Conclude as soon as the list is assembled.`;

// ── Tool schemas ──────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_wikidata_sites",
    description:
      "Search Wikidata by name in a given language. Returns candidates (QID, label, description, P31 types). Call once with language 'en' and once with 'fr', then merge.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        language: { type: "string", enum: ["en", "fr"], description: "Search language" },
      },
      required: ["query", "language"],
    },
  },
  {
    name: "get_wikidata_entity",
    description:
      "Full detail of one entity (types, description, coordinates, country). Use to judge whether a doubtful candidate is actually a place.",
    input_schema: {
      type: "object" as const,
      properties: { qid: { type: "string" } },
      required: ["qid"],
    },
  },
  {
    name: "check_site_exists",
    description:
      "Is this QID already in the atlas? Call for every candidate you keep, to set already_in_base.",
    input_schema: {
      type: "object" as const,
      properties: { qid: { type: "string" } },
      required: ["qid"],
    },
  },
  {
    name: "submit_candidates",
    description:
      "Submit the final PROPOSED candidate list. Ends your work. Include already-present places too (flagged already_in_base=true).",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description: "What you searched, kept, and discarded as noise.",
        },
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              qid: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              type: { type: "string", description: "short type hint, e.g. 'archaeological site'" },
              lat: { type: "number" },
              lon: { type: "number" },
              already_in_base: { type: "boolean" },
              existing_title: { type: "string" },
            },
            required: ["qid", "label", "already_in_base"],
          },
        },
      },
      required: ["reasoning", "proposals"],
    },
  },
];

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function dispatchTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "search_wikidata_sites":
      return JSON.stringify(
        await searchWikidataSites(input.query, 10, input.language ?? "en"),
        null, 1,
      );
    case "get_wikidata_entity":
      return JSON.stringify(await getWikidataEntity(input.qid), null, 1);
    case "check_site_exists":
      return JSON.stringify(await checkSiteExists(input.qid), null, 1);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── The loop ──────────────────────────────────────────────────────────────────

export async function discoverCandidates(
  request: string,
  opts: { verbose?: boolean } = {},
): Promise<DiscoveryResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");
  const anthropic = new Anthropic({ apiKey });
  const verbose = opts.verbose ?? true;
  const log = (m: string) => verbose && console.log(`[discovery] ${m}`);
  const toolCalls: string[] = [];
  const seenCalls = new Map<string, string>();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Discovery request: ${request}` },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    for (const b of response.content) {
      if (b.type === "text" && b.text.trim()) log(`turn ${turn} thinking: ${b.text.trim()}`);
    }

    const submit = toolUses.find((t) => t.name === "submit_candidates");
    if (submit) {
      const input = submit.input as { reasoning: string; proposals: CandidateProposal[] };
      log(`turn ${turn}: submit_candidates (${input.proposals?.length ?? 0} proposals)`);
      return {
        request,
        proposals: input.proposals ?? [],
        reasoning: input.reasoning ?? "",
        turns: turn,
        tool_calls: toolCalls,
      };
    }

    if (toolUses.length === 0) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "Continue using your tools, then conclude with submit_candidates.",
      });
      continue;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const argsPreview = JSON.stringify(tu.input).slice(0, 120);
      const callKey = `${tu.name}:${JSON.stringify(tu.input)}`;

      if (seenCalls.has(callKey)) {
        log(`turn ${turn}: ${tu.name}(${argsPreview}) [REPEATED — short-circuited]`);
        toolCalls.push(`${tu.name}(${argsPreview}) [repeat]`);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content:
            `You already called ${tu.name} with these exact arguments and got:\n\n${seenCalls.get(callKey)}\n\n` +
            `Do not call it again. Use this result. If the list is complete, conclude with submit_candidates.`,
        });
        continue;
      }

      log(`turn ${turn}: ${tu.name}(${argsPreview})`);
      toolCalls.push(`${tu.name}(${argsPreview})`);
      try {
        const output = await dispatchTool(tu.name, tu.input);
        seenCalls.set(callKey, output);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      } catch (err: any) {
        // Failures stay retryable (not cached) — transient throttling can clear.
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${err?.message ?? String(err)}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  // Guardrail: no submission within MAX_TURNS.
  return {
    request,
    proposals: [],
    reasoning: `Discovery did not converge within ${MAX_TURNS} turns.`,
    turns: MAX_TURNS,
    tool_calls: toolCalls,
  };
}
