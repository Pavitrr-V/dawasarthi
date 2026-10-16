import "dotenv/config";
import { config } from "dotenv";
import { resolve } from "node:path";
import {
  searchWeb,
  fetchPage,
  startAgentRun,
  getAgentRun,
} from "../lib/tinyfish";

config({ path: resolve(process.cwd(), ".env.local") });

/**
 * Manual TinyFish smoke test. Runs one Search, one Fetch and one Agent run
 * against harmless public pages, printing each result.
 *
 * Run: npx tsx scripts/tinyfish-smoke.ts
 *
 * Requires TINYFISH_API_KEY in .env.local, and SUPABASE_SERVICE_ROLE_KEY for
 * the agent-run budget guard. Never prints the key.
 */

const SMOKE_SEARCH_QUERY = "WHO essential medicines list paracetamol";
const SMOKE_FETCH_URL = "https://example.com";
const SMOKE_AGENT_URL = "https://example.com";
const SMOKE_AGENT_GOAL = "Report the page's main heading as plain text.";

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 15;

function log(section: string, value: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(value);
}

async function checkSearch() {
  try {
    const results = await searchWeb(SMOKE_SEARCH_QUERY);
    log("SEARCH", `${results.length} result(s)`);
    for (const result of results.slice(0, 5)) {
      console.log(`- ${result.title || "(no title)"} -> ${result.url}`);
      if (result.snippet) console.log(`  ${result.snippet.slice(0, 160)}`);
    }
  } catch (error) {
    log("SEARCH FAILED", error instanceof Error ? error.message : error);
  }
}

async function checkFetch() {
  try {
    const page = await fetchPage(SMOKE_FETCH_URL);
    log("FETCH", page.url);
    console.log(`title: ${page.title || "(none)"}`);
    console.log(`text (first 300 chars): ${page.text.slice(0, 300)}`);
  } catch (error) {
    log("FETCH FAILED", error instanceof Error ? error.message : error);
  }
}

async function checkAgent() {
  try {
    const handle = await startAgentRun({
      url: SMOKE_AGENT_URL,
      goal: SMOKE_AGENT_GOAL,
    });
    log("AGENT STARTED", `run_id=${handle.runId}`);

    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
      const run = await getAgentRun(handle.runId);
      console.log(`  poll ${attempt}: ${run.status}`);

      if (run.status !== "running") {
        log("AGENT FINISHED", run.status);
        if (run.error) console.log(`error: ${run.error}`);
        console.log("result:", JSON.stringify(run.result, null, 2));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    log("AGENT", "still running after max polls; stopping");
  } catch (error) {
    log("AGENT FAILED", error instanceof Error ? error.message : error);
  }
}

async function main() {
  console.log("TinyFish smoke test (search + fetch + agent run)");
  await checkSearch();
  await checkFetch();
  await checkAgent();
  console.log("\nDone.");
}

void main();
