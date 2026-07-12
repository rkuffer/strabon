-- =============================================================================
-- Run history — observability of the extraction process itself.
--
-- Rationale. The model is not deterministic: two runs on the same site, with the
-- same prompt, produce different timelines. Today each extraction OVERWRITES the
-- previous one, so that variance is invisible and unexploitable.
--
-- These two tables keep every run and every prompt version, so we can measure:
--   - how much the model varies run to run (is a given entry stable?)
--   - whether a change in OUR prompt, or in OUR referential, caused a regression
--     — as opposed to plain noise, which we have almost certainly confused with
--     each other so far.
--
-- Nothing is consumed yet. `sites.timeline` keeps being written exactly as before
-- (last run wins). This is the corpus we need BEFORE designing a consolidator, so
-- that its thresholds and matching rules come from real data rather than guesswork.
-- =============================================================================

-- ── Prompt versions ──────────────────────────────────────────────────────────
-- The prompt is CODE and lives in the repo (git is the source of truth). This
-- table is a LOG, not a source: it archives what actually ran, the way a
-- deployment log records what was shipped. It lets us diff two versions of the
-- instructions the day we need to explain a regression.
--
-- The hash is taken on the TEMPLATE — the raw instructions with their {{markers}}
-- unsubstituted — never on an instantiated prompt. An instantiated prompt embeds
-- the site's Wikipedia context and would hash differently for every site, making
-- the history worthless.

CREATE TABLE IF NOT EXISTS prompt_versions (
  hash          text PRIMARY KEY,          -- sha256 of the template, truncated
  kind          text NOT NULL,             -- 'extraction' | 'resolution' | ...
  template      text NOT NULL,             -- full text, with {{markers}} intact
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  run_count     integer NOT NULL DEFAULT 0,
  note          text                       -- optional, hand-written
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_kind
  ON prompt_versions (kind, first_seen_at DESC);


-- ── Extraction runs ──────────────────────────────────────────────────────────
-- One row per LLM extraction, confirmed or not.
--
-- We keep REJECTED runs too. A run the human threw away is often a bad one — and
-- a bad run is exactly the sample we need to characterise the failure modes. The
-- `confirmed` flag records the human's verdict without discarding the evidence.

CREATE TABLE IF NOT EXISTS site_extractions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id           text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  timeline          jsonb NOT NULL,        -- the run's output, post-normalisation
                                           -- and post-validation (i.e. what would
                                           -- have been written to sites.timeline)

  model             text NOT NULL,         -- e.g. claude-sonnet-4-6
  prompt_hash       text REFERENCES prompt_versions(hash),

  -- Hash of the referential's QID set at run time. A richer referential changes
  -- the model's behaviour — that is the whole point of filling it — so a run is
  -- only strictly comparable to another that saw the SAME referential. Without
  -- this, we would confuse "our coverage improved" with "the model varied".
  referential_hash  text,

  -- Provenance and outcome, cheap to store and useful when reading a run back.
  local_lang        text,                  -- local-language Wikipedia used, if any
  qid_violations    integer NOT NULL DEFAULT 0,
  rejected          boolean NOT NULL DEFAULT false,  -- LLM said "not an inhabited place"
  rejection_reason  text,

  confirmed         boolean NOT NULL DEFAULT false,  -- human validated this run
  run_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_extractions_site
  ON site_extractions (site_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_extractions_prompt
  ON site_extractions (prompt_hash);

-- Sites with several runs: the corpus for variance analysis.
CREATE INDEX IF NOT EXISTS idx_site_extractions_confirmed
  ON site_extractions (site_id) WHERE confirmed;
