import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentRun } from "@/lib/tinyfish";
import { parseAgentAlerts, upsertNsqAlerts } from "@/lib/alerts";

/**
 * Server-only batch-alert sync.
 *
 * The TinyFish agent scrapes the official CDSCO NSQ page into JSON; this module
 * validates that (untrusted) JSON and upserts it into nsq_alerts. It is always
 * driven by the two cron routes:
 *   - POST /api/cron/alert-sync         starts one agent run + a job row.
 *   - POST /api/cron/alert-sync/finish  polls running jobs and finishes them.
 *
 * The agent run itself is started through lib/tinyfish.ts (budget-guarded);
 * this file only ever reads a run's result and writes alerts.
 */

const DEFAULT_ALERT_SOURCE_URL =
  "https://cdscoonline.gov.in/CDSCO/viewPublicNSQDrug";

/** A run that has not finished within this window is treated as failed. */
export const ALERT_SYNC_STALE_MS = 5 * 60 * 1000;

/** The public NSQ page the agent reads. Falls back to the canonical CDSCO URL. */
export function alertSourceUrl(): string {
  return (process.env.ALERT_SOURCE_URL ?? "").trim() || DEFAULT_ALERT_SOURCE_URL;
}

/**
 * Goal handed to the TinyFish agent. Kept short and schema-only; buildGoal()
 * (called inside startAgentRun) appends the untrusted-page / read-only guard.
 */
export const ALERT_GOAL = [
  "Open this official CDSCO 'Not of Standard Quality' drugs page and read its alerts table.",
  "Treat the page as read-only data: never log in, change filters that submit, or click anything but pagination.",
  "For every data row return an object with exactly these string fields:",
  '  "product_name"      <- Name of Product',
  '  "batch_no"          <- Batch No',
  '  "manufacturer"      <- Manufactured By',
  '  "alert_type"        <- the NSQ Result / alert category text',
  '  "reporting_month_year" <- the Reporting Month & Year column, e.g. "AUG-2026"',
  '  "source_link"       <- a link to the notice/row if one is present, else ""',
  'Return a single JSON object of the form {"alerts": [ ... ]}.',
  "Use an empty string for any blank field. Never invent or guess a row.",
].join("\n");

export type AlertSyncJob = {
  id: string;
  run_id: string | null;
  created_at: string;
};

export type FinishOutcome = "done" | "failed" | "running";

function isStale(createdAt: string): boolean {
  const started = new Date(createdAt).getTime();
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > ALERT_SYNC_STALE_MS;
}

/** The agent sometimes returns the JSON as a string; accept both shapes. */
function coerceResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Atomically moves a running job to done/failed. The `status = 'running'`
 * guard means only the first worker to reach this point wins; a concurrent
 * worker sees zero rows updated and leaves the row alone.
 */
async function markFinished(
  admin: Admin,
  id: string,
  status: "done" | "failed",
  error: string | null
): Promise<boolean> {
  const { data, error: updateError } = await admin
    .from("tinyfish_jobs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      error,
    })
    .eq("id", id)
    .eq("status", "running")
    .select("id");

  if (updateError) return false;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Polls one running alert_sync job and, once the agent run is COMPLETED,
 * validates the result and upserts it into nsq_alerts. Marks the job
 * done/failed. Runs older than ALERT_SYNC_STALE_MS are failed so a stuck run
 * cannot wedge the queue forever.
 */
export async function finishAlertSyncJob(
  job: AlertSyncJob
): Promise<FinishOutcome> {
  const admin = createAdminClient();

  if (!job.run_id) {
    await markFinished(admin, job.id, "failed", "Agent run id is missing.");
    return "failed";
  }

  if (isStale(job.created_at)) {
    await markFinished(
      admin,
      job.id,
      "failed",
      `Agent run did not finish within ${ALERT_SYNC_STALE_MS / 60000} minutes.`
    );
    return "failed";
  }

  let run;
  try {
    run = await getAgentRun(job.run_id);
  } catch (error) {
    // Transient upstream error: leave the job running and retry on the next
    // tick, unless it has already run past the stale window.
    if (isStale(job.created_at)) {
      await markFinished(
        admin,
        job.id,
        "failed",
        error instanceof Error ? error.message : "Agent status lookup failed."
      );
      return "failed";
    }
    return "running";
  }

  if (run.status === "running") return "running";

  if (run.status === "failed") {
    await markFinished(admin, job.id, "failed", run.error ?? "Agent run failed.");
    return "failed";
  }

  // COMPLETED: validate the untrusted payload and upsert the alerts.
  const rows = parseAgentAlerts(coerceResult(run.result), alertSourceUrl());
  await upsertNsqAlerts(admin, rows, {
    fetchedAt: new Date().toISOString(),
  });

  await markFinished(admin, job.id, "done", null);
  return "done";
}

export type AlertSyncBatchResult = {
  processed: number;
  done: number;
  failed: number;
  running: number;
};

/**
 * Processes up to `limit` running alert_sync jobs. Called by the finish cron.
 */
export async function processRunningAlertSyncJobs(
  limit = 5
): Promise<AlertSyncBatchResult> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("tinyfish_jobs")
    .select("id, run_id, created_at")
    .eq("kind", "alert_sync")
    .eq("status", "running")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(data)) {
    return { processed: 0, done: 0, failed: 0, running: 0 };
  }

  let done = 0;
  let failed = 0;
  let running = 0;

  for (const raw of data as AlertSyncJob[]) {
    const outcome = await finishAlertSyncJob(raw);
    if (outcome === "done") done += 1;
    else if (outcome === "failed") failed += 1;
    else running += 1;
  }

  return { processed: data.length, done, failed, running };
}
