import { NextResponse } from "next/server";
import {
  AuthError,
  BudgetExceeded,
  RateLimitError,
  UpstreamError,
} from "@/lib/tinyfish";
import { startAlertSyncJob } from "@/lib/alert-sync";
import { isAuthorizedCron } from "@/lib/cron";

export const maxDuration = 60;

/**
 * Starts one TinyFish agent run that scrapes the official NSQ page, and records
 * a running `tinyfish_jobs` row for it. The run is finished later by
 * POST /api/cron/alert-sync/finish (poll-side) or by the reminder tick's job
 * poller, so this handler returns fast.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`. Respects the TinyFish daily
 * budget guard; when the cap is reached it returns 200 with skipped=true rather
 * than erroring, so an over-cap cron tick is not treated as a failure.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { jobId, runId } = await startAlertSyncJob();
    return NextResponse.json({ ok: true, job_id: jobId, run_id: runId });
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
}
