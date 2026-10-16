import { NextResponse } from "next/server";
import { processRunningVerifyJobs } from "@/lib/verify";
import { isAuthorizedCron } from "@/lib/cron";

export const maxDuration = 60;

/**
 * Finishes any running verify jobs: polls their TinyFish run and, once
 * COMPLETED, validates the result into online_verifications and recomputes the
 * medicine's verdict. Jobs running longer than 5 minutes are marked failed.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`.
 */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await processRunningVerifyJobs({ minAgeMs: 0, limit: 10 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not finish verify jobs.",
      },
      { status: 500 }
    );
  }
}
