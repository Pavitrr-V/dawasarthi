import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentRun } from "@/lib/tinyfish";
import { parsePriceResult, type PriceQuote } from "@/lib/price-parse";

/**
 * Finishes a `tinyfish_jobs` (kind='price') row for the reminder worker.
 *
 * A price job asks the agent to read public listings for one medicine; on
 * COMPLETED the untrusted payload is validated by lib/price-parse.ts and the
 * quotes are written into `price_quotes`. Runs older than PRICE_STALE_MS are
 * failed so a stuck run can never wedge the poll queue.
 *
 * This mirrors finishVerifyJob / finishAlertSyncJob in shape and is dispatched
 * by lib/reminder-tick.ts step 5.
 */

/** A run that has not finished within this window is treated as failed. */
export const PRICE_STALE_MS = 5 * 60 * 1000;

export type PriceJob = {
  id: string;
  medicine_id: string | null;
  run_id: string | null;
  created_at: string;
};

export type FinishOutcome = "done" | "failed" | "running";

type Admin = ReturnType<typeof createAdminClient>;

function isStale(createdAt: string): boolean {
  const started = new Date(createdAt).getTime();
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > PRICE_STALE_MS;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Agent status lookup failed.";
}

/**
 * Atomically moves a running job to done/failed. The `status = 'running'` guard
 * means only the first worker to reach this point wins.
 */
async function markJob(admin: Admin, id: string, status: "done" | "failed"): Promise<void> {
  await admin
    .from("tinyfish_jobs")
    .update({ status, finished_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "running")
    .select("id");
}

async function storeQuotes(
  admin: Admin,
  medicineId: string,
  quotes: PriceQuote[]
): Promise<void> {
  if (quotes.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const rows = quotes.map((quote) => ({
    medicine_id: medicineId,
    source_site: quote.source_site,
    source_url: quote.source_url,
    price: quote.price,
    pack_size: quote.pack_size,
    in_stock: quote.in_stock,
    fetched_at: fetchedAt,
  }));
  await admin.from("price_quotes").insert(rows);
}

/**
 * Polls one running price job and, once the agent run finished, stores the
 * validated quotes and marks the job done. Transient upstream errors leave the
 * job running to retry; stale runs are failed.
 */
export async function finishPriceJob(job: PriceJob): Promise<FinishOutcome> {
  const admin = createAdminClient();

  if (!job.run_id) {
    await markJob(admin, job.id, "failed");
    return "failed";
  }

  if (isStale(job.created_at)) {
    await markJob(admin, job.id, "failed");
    return "failed";
  }

  let run;
  try {
    run = await getAgentRun(job.run_id);
  } catch (error) {
    if (isStale(job.created_at)) {
      console.warn("[price] polling failed:", messageOf(error));
      await markJob(admin, job.id, "failed");
      return "failed";
    }
    return "running";
  }

  if (run.status === "running") return "running";

  if (run.status === "failed") {
    await markJob(admin, job.id, "failed");
    return "failed";
  }

  const quotes = parsePriceResult(run.result);
  if (job.medicine_id && quotes.length > 0) {
    await storeQuotes(admin, job.medicine_id, quotes);
  }

  await markJob(admin, job.id, "done");
  return "done";
}
