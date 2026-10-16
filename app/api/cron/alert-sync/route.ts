import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AuthError,
  BudgetExceeded,
  RateLimitError,
  UpstreamError,
  startAgentRun,
} from "@/lib/tinyfish";
import { ALERT_GOAL, alertSourceUrl } from "@/lib/alert-sync";
import { isAuthorizedCron } from "@/lib/cron";

export const maxDuration = 60;

/**
 * Starts one TinyFish agent run that scrapes the official NSQ page, and records
 * a running `tinyfish_jobs` row for it. The run is finished later by
 * POST /api/cron/alert-sync/finish (poll-side), so this handler returns fast.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`. Respects the TinyFish daily
 * budget guard; when the cap is reached it returns 200 with skipped=true rather
 * than erroring, so an over-cap cron tick is not treated as a failure.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let runId: string;
  try {
    const run = await startAgentRun({ url: alertSourceUrl(), goal: ALERT_GOAL });
    runId = run.runId;
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return NextResponse.json(
        { ok: false, skipped: true, reason: error.message },
        { status: 200 }
      );
    }
    if (error instanceof AuthError || error instanceof RateLimitError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 502 }
      );
    }
    if (error instanceof UpstreamError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 502 }
      );
    }
    // ConfigError (missing key) or anything unexpected.
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Could not start the run.",
      },
      { status: 500 }
    );
  }

  const admin = createAdminClient();
  const jobId = crypto.randomUUID();

  const { error } = await admin.from("tinyfish_jobs").insert({
    id: jobId,
    kind: "alert_sync",
    run_id: runId,
    status: "running",
    // Alert sync is site-wide, not tied to a patient's medicine.
    medicine_id: null,
    user_id: null,
  });

  if (error) {
    return NextResponse.json(
      { ok: false, error: "Could not record the alert-sync job." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, job_id: jobId, run_id: runId });
}
