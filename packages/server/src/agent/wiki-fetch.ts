// packages/server/src/agent/wiki-fetch.ts
// =============================================================================
// Shared Wikimedia (Wikidata / Wikipedia) fetch utility.
//
// Wikimedia APIs throttle bursts (HTTP 429). Every tool that hits wikidata.org
// or wikipedia.org should go through THIS function so that:
//   - a global minimum spacing is enforced between requests (politeness), and
//   - transient 429/5xx/network errors are retried with exponential backoff,
// transparently — the caller (and the agent) never has to think about it.
//
// Reuse this in any Wiki*-touching code (resolution tools, indexer, enricher,
// wikipedia context builder, future tools) instead of a bare fetch.
// =============================================================================

// Wikimedia requires an identifiable User-Agent (403 otherwise).
export const WIKI_USER_AGENT =
  "Strabon2/0.1 (pan-historical atlas; https://github.com/rkuffer/strabon)";

const MIN_SPACING_MS = 150;   // minimum gap between two Wikimedia requests
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 400;  // 400, 800, 1600, 3200, 6400

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Global serialization gate: chains requests so they never fire in a burst.
// Each call waits until at least MIN_SPACING_MS after the previous one started.
let lastStart = 0;
let gate: Promise<void> = Promise.resolve();

async function throttle(): Promise<void> {
  // Serialize on the shared gate, then respect the minimum spacing.
  const mine = gate.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastStart + MIN_SPACING_MS - now);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  });
  // Next caller waits for mine to finish scheduling.
  gate = mine.catch(() => {});
  return mine;
}

/**
 * Fetch JSON from a Wikimedia endpoint with global spacing + retry/backoff.
 */
export async function wikiFetchJson(url: string): Promise<any> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": WIKI_USER_AGENT },
      });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new Error(`Wikimedia HTTP ${res.status} after ${MAX_ATTEMPTS} retries`);
      }
      if (!res.ok) {
        throw new Error(`Wikimedia HTTP ${res.status} on ${url.slice(0, 120)}`);
      }
      return await res.json();
    } catch (err: any) {
      const transient = /network|ECONN|timeout|fetch failed|429|5\d\d/i.test(
        String(err?.message),
      );
      if (transient && attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
