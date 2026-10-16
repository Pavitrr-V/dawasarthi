import { NextResponse } from "next/server";
import { processRunningAlertSyncJobs } from "@/lib/alert-sync";
import { isAuthorizedCron } from "@/lib/cron";

export const maxDuration = 60;

/**
 * Finishes any running alert_sync jobs: polls their TinyFish run, and once
 * COMPLETED validates the result and upserts it into nsq_alerts. Jobs that have
 * been running longer than 5 minutes are marked failed.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await processRunningAlertSyncJobs();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not finish alert jobs.",
      },
      { status: 500 }
    );
  }
}
