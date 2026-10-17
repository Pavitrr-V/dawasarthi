import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { runReminderTick } from "@/lib/reminder-tick";

export const maxDuration = 60;

/**
 * The minute-by-minute reminder worker.
 *
 * One call runs, in order: first reminder, repeat reminder, caregiver
 * escalation, the daily dose top-up, the weekly alert sync, then the TinyFish
 * job poller (see lib/reminder-tick.ts). Everything is idempotent, so an
 * overlapping tick is harmless.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`. Vercel Cron sends this header
 * automatically when CRON_SECRET is set; the pg_cron + pg_net alternative sends
 * it explicitly (see supabase/cron/tick_pg_cron.sql).
 *
 * Always returns 200 once the tick has run (per-step failures are reported in
 * the body) so a single failing integration is not retried in a hot loop.
 */
async function handle(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await runReminderTick();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Reminder tick failed.",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

/** Convenience for pg_net's `net.http_post` and manual curl runs. */
export async function POST(request: Request) {
  return handle(request);
}
