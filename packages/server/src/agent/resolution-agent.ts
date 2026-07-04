// packages/server/src/agent/resolution-agent.ts
// =============================================================================
// Resolution agent — the tool-use loop.
//
// Contract:
//   resolveCandidate(candidate) → structured verdict
//   - The agent READS (5 tools) and JUDGES. It never writes. Code applies verdicts.
//   - Terminal tool `submit_verdict`: the loop ends when the agent calls it.
//   - Guardrail: after MAX_TURNS without a verdict → forced needs_human.
//
// Scope reminder (see design notes): the atlas covers ANY inhabited place
// across ~12,000 years — tells AND living cities AND recent towns. No
// archaeological bias.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import {
  searchWikidataSites,
  getWikidataEntity,
  geoDistance,
  checkSiteExists,
  getWikipediaIntro,
} from "./resolution-tools.js";

const MODEL = process.env.ANTHROPIC_RESOLUTION_MODEL ?? "claude-sonnet-4-6";
const MAX_TURNS = 12;

// ── Verdict types ─────────────────────────────────────────────────────────────

export type SplitSite = {
  qid: string;
  title: string;
  lat?: number | null;
  lon?: number | null;
};

export type ResolutionVerdict = {
  verdict: "single" | "split" | "duplicate" | "rejected" | "needs_human";
  reasoning: string;
  // single
  qid?: string;
  title?: string;
  lat?: number | null;
  lon?: number | null;
  // split (sites[0] = ancient/earlier, sites[1] = modern/later)
  sites?: SplitSite[];
  relation_note?: string;
  timeline_to_hint?: number | null; // applies to sites[0] (ancient)
  timeline_from_hint?: number | null; // applies to sites[1] (modern)
  // duplicate
  existing_qid?: string;
  existing_title?: string;
  // rejected
  reason?: string;
  // needs_human
  question?: string;
  options?: string[];
};

export type CandidateInput = {
  raw_title: string;
  wikidata_id?: string | null;
  description?: string | null;
  lat?: number | null;
  lon?: number | null;
  discovery_intent?: string | null;
};

export type ResolutionRun = {
  verdict: ResolutionVerdict;
  turns: number;
  tool_calls: string[]; // audit trail: "search_wikidata_sites({...})"
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Resolution agent of Strabon, a pan-historical world atlas covering ~12,000 years of human settlements.

# Mission
You receive ONE site candidate (a raw title, possibly with a tentative Wikidata QID and metadata). Resolve its identity: determine which real-world inhabited place(s) it designates, and submit a structured verdict.

# Scope — read carefully
The atlas covers ANY inhabited place across 12,000 years: Neolithic tells, antique cities, medieval towns, living modern cities, recent towns. Do NOT assume a candidate must be archaeological. Judge from the candidate's context (title, description, discovery intent) what KIND of place is expected:
- "Hacılar" with intent "Neolithic sites of Anatolia" → an archaeological site is expected.
- "Marseille" → a living city is expected.
A candidate is valid if it is a LOCALIZABLE INHABITED PLACE. Reject non-places (periods, abstract regions, concepts, lists).

# Method
1. If the candidate carries a QID, VERIFY it first with get_wikidata_entity: do its types, description and location match the expected kind of place? Wrong QIDs are common (e.g. a homonymous modern village instead of the intended Neolithic tell).
2. If there is no QID, or the QID is wrong, search by name with search_wikidata_sites. Examine ALL returned candidates (types + descriptions). If every result is of an obviously wrong kind for this candidate (e.g. only modern villages when an ancient site is expected), REFORMULATE the search: try "höyük", "tell", "mound", "archaeological site", alternative spellings, or the native-language name. Reformulate toward archaeological terms ONLY when the expected kind justifies it — never by default.
3. Decide whether the ancient/modern question arises AT ALL:
   - Purely modern town → single. Done.
   - Continuously inhabited city at the SAME location (Marseille, despite 2,600 years of history) → single.
   - The split question only arises when TWO DISTINCT entities exist at DIFFERENT locations (an ancient site AND a modern successor).
4. Split decision — BOTH criteria must hold:
   - GEOGRAPHY: the two locations are genuinely distinct (use geo_distance; a few km apart with distinct Wikidata entities is a strong signal).
   - IMPORTANCE: the place is historically and editorially significant enough to justify two atlas entries. Corinth (major ancient polis + significant modern city, ~6 km apart) → split. An obscure village that moved a few km after a disaster → single (keep the modern entity).
   If geography says "distinct" but importance is intermediate or unclear → needs_human.
5. Succession chains (replaces / replaced_by) indicate CONTINUITY of a living city (Byzantium → Constantinople → Istanbul: the same city renamed through history) → single, resolved to the MODERN endpoint of the chain, unless geography+importance argue for a split.
6. Before submitting single or split, ALWAYS call check_site_exists on the retained QID(s). Already present in the database → duplicate.
7. Timeline cut bounds (split only): timeline_to_hint (end of the ancient site's timeline) and timeline_from_hint (start of the modern site's) MUST be SOURCED from data you actually saw during this run (Wikidata inception/dissolution, Wikipedia intro). NEVER guess a year from memory. If you cannot source the cut, leave the hints null and say so in reasoning.
8. Do NOT confuse an ancient/modern SPLIT (two sites, different locations) with an occupation HIATUS (same site, interrupted occupation — handled downstream at extraction, not by you).
9. get_wikipedia_intro is a SECOND RESORT: use it only when the structured data (succession chains, types) does not answer the ancient/modern question but the article prose likely does ("X is the ancient name of Y", "the modern city lies N km away").

# Hard rules
- No Wikidata QID = no site. If no entity genuinely matches → rejected.
- You never write anything. You observe, reason, and submit ONE verdict via submit_verdict.
- reasoning is ALWAYS required: cite the evidence you used (types, distances, chains, intro statements).
- When the decision is editorial and borderline → needs_human with a precise question and, when possible, closed options.

# Efficiency
Most candidates resolve in 2–4 tool calls. Do not fetch what you do not need. Conclude as soon as the evidence suffices.`;

// ── Tool schemas (SDK) ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_wikidata_sites",
    description:
      "Search Wikidata entities by name. Returns several candidates with QID, label, description and P31 types. Reformulate the query if results are all of a wrong kind for this candidate.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Name to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_wikidata_entity",
    description:
      "Full detail of one Wikidata entity: P31 types, succession chain (replaces / replaced_by), coordinates, country, inception/dissolution years, English Wikipedia title.",
    input_schema: {
      type: "object" as const,
      properties: {
        qid: { type: "string", description: "Wikidata QID, e.g. Q908860" },
      },
      required: ["qid"],
    },
  },
  {
    name: "geo_distance",
    description: "Great-circle distance in km between two coordinate pairs.",
    input_schema: {
      type: "object" as const,
      properties: {
        latA: { type: "number" },
        lonA: { type: "number" },
        latB: { type: "number" },
        lonB: { type: "number" },
      },
      required: ["latA", "lonA", "latB", "lonB"],
    },
  },
  {
    name: "check_site_exists",
    description:
      "Is this QID already known in our database — as a production site or as a pending candidate? ALWAYS call before submitting single or split.",
    input_schema: {
      type: "object" as const,
      properties: {
        qid: { type: "string" },
      },
      required: ["qid"],
    },
  },
  {
    name: "get_wikipedia_intro",
    description:
      "Plain-text intro of an English Wikipedia page. SECOND RESORT: only when structured Wikidata does not answer the ancient/modern question but the prose likely does.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "English Wikipedia page title" },
      },
      required: ["title"],
    },
  },
  {
    name: "submit_verdict",
    description:
      "Submit your FINAL resolution verdict. This ends your work on this candidate. Call it exactly once, when the evidence suffices.",
    input_schema: {
      type: "object" as const,
      properties: {
        verdict: {
          type: "string",
          enum: ["single", "split", "duplicate", "rejected", "needs_human"],
        },
        reasoning: {
          type: "string",
          description:
            "Always required. Cite the evidence used: types, distances, succession chains, intro statements.",
        },
        qid: { type: "string", description: "single only: the retained QID" },
        title: { type: "string", description: "single only: site title" },
        lat: { type: "number", description: "single only" },
        lon: { type: "number", description: "single only" },
        sites: {
          type: "array",
          description:
            "split only: EXACTLY 2 items. Index 0 = ancient/earlier site, index 1 = modern/later site.",
          items: {
            type: "object",
            properties: {
              qid: { type: "string" },
              title: { type: "string" },
              lat: { type: "number" },
              lon: { type: "number" },
            },
            required: ["qid", "title"],
          },
        },
        relation_note: {
          type: "string",
          description:
            "split only: human-readable note describing the relation between the two sites (stored in meta on both).",
        },
        timeline_to_hint: {
          type: "integer",
          description:
            "split only: SOURCED end-year for the ancient site's timeline (sites[0]). Null if not sourced.",
        },
        timeline_from_hint: {
          type: "integer",
          description:
            "split only: SOURCED start-year for the modern site's timeline (sites[1]). Null if not sourced.",
        },
        existing_qid: { type: "string", description: "duplicate only" },
        existing_title: { type: "string", description: "duplicate only" },
        reason: { type: "string", description: "rejected only" },
        question: {
          type: "string",
          description: "needs_human only: precise question for the human",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "needs_human only: closed options when possible",
        },
      },
      required: ["verdict", "reasoning"],
    },
  },
];

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function dispatchTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "search_wikidata_sites":
      return JSON.stringify(await searchWikidataSites(input.query), null, 1);
    case "get_wikidata_entity":
      return JSON.stringify(await getWikidataEntity(input.qid), null, 1);
    case "geo_distance":
      return JSON.stringify(
        geoDistance(input.latA, input.lonA, input.latB, input.lonB),
      );
    case "check_site_exists":
      return JSON.stringify(await checkSiteExists(input.qid), null, 1);
    case "get_wikipedia_intro":
      return JSON.stringify(await getWikipediaIntro(input.title), null, 1);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── The loop ──────────────────────────────────────────────────────────────────

export async function resolveCandidate(
  candidate: CandidateInput,
  opts: { verbose?: boolean } = {},
): Promise<ResolutionRun> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");
  const anthropic = new Anthropic({ apiKey });
  const log = (msg: string) =>
    opts.verbose && console.log(`[resolution] ${msg}`);
  const toolCalls: string[] = [];

  const userMessage = [
    `Candidate to resolve:`,
    `- raw_title: ${candidate.raw_title}`,
    candidate.wikidata_id
      ? `- tentative wikidata_id: ${candidate.wikidata_id}`
      : null,
    candidate.description ? `- description: ${candidate.description}` : null,
    candidate.lat != null && candidate.lon != null
      ? `- coordinates: ${candidate.lat}, ${candidate.lon}`
      : null,
    candidate.discovery_intent
      ? `- discovery intent: ${candidate.discovery_intent}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Collect tool calls from this turn.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Terminal tool → verdict.
    const verdictCall = toolUses.find((t) => t.name === "submit_verdict");
    if (verdictCall) {
      log(`turn ${turn}: submit_verdict`);
      toolCalls.push(`submit_verdict`);
      return {
        verdict: verdictCall.input as ResolutionVerdict,
        turns: turn,
        tool_calls: toolCalls,
      };
    }

    if (toolUses.length === 0) {
      // Model answered in plain text without concluding — nudge it once.
      log(`turn ${turn}: no tool call, nudging toward submit_verdict`);
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content:
          "Please continue using your tools, and conclude with submit_verdict.",
      });
      continue;
    }

    // Execute tools and feed results back.
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const argsPreview = JSON.stringify(tu.input).slice(0, 120);
      log(`turn ${turn}: ${tu.name}(${argsPreview})`);
      toolCalls.push(`${tu.name}(${argsPreview})`);
      try {
        const output = await dispatchTool(tu.name, tu.input);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: output,
        });
      } catch (err: any) {
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

  // Guardrail: no verdict within MAX_TURNS → forced escalation.
  return {
    verdict: {
      verdict: "needs_human",
      reasoning: `Agent did not converge within ${MAX_TURNS} turns.`,
      question: `Resolution did not converge for "${candidate.raw_title}". Please review this candidate manually.`,
    },
    turns: MAX_TURNS,
    tool_calls: toolCalls,
  };
}
