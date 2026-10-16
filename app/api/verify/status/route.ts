import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  loadLatestJob,
  loadOnlineCheck,
  onlineChipStatus,
} from "@/lib/risk-data";
import { processRunningVerifyJobs, VERIFY_SETTLE_MS } from "@/lib/verify";

export const maxDuration = 60;

const querySchema = z.object({
  medicine_id: z.string().uuid(),
});

/**
 * Polling fallback for the trust card's "Online checks" strip.
 *
 * Before answering it advances any of this medicine's verify jobs that have had
 * time to settle (VERIFY_SETTLE_MS) — polling the TinyFish run and writing the
 * result — so the check completes even when Realtime is unavailable. Ownership
 * is enforced by RLS on the medicine read; the background finish uses the
 * service role but is scoped to the medicine the caller owns.
 *
 * Responds with the latest job status so the client knows when to recompute the
 * verdict and refresh: `{ status, finished, onlineStatus, lastCheckedAt }`.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (user.role !== "patient") {
    return NextResponse.json(
      { error: "Only a patient account can run this check." },
      { status: 403 }
    );
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A medicine id is required." },
      { status: 400 }
    );
  }
  const medicineId = parsed.data.medicine_id;

  const supabase = await createClient();
  const { data } = await supabase
    .from("medicines")
    .select("id")
    .eq("id", medicineId)
    .maybeSingle();
  if (!data) {
    return NextResponse.json({ error: "Medicine not found." }, { status: 404 });
  }

  // Advance jobs that have had time to settle. A failure here must not stop us
  // from reporting the current status.
  try {
    await processRunningVerifyJobs({
      medicineId,
      minAgeMs: VERIFY_SETTLE_MS,
      limit: 5,
    });
  } catch (error) {
    console.warn(
      "[verify] status finish failed:",
      error instanceof Error ? error.message : error
    );
  }

  const [online, job] = await Promise.all([
    loadOnlineCheck(supabase, medicineId),
    loadLatestJob(supabase, medicineId),
  ]);

  const status = job.status ?? "none";

  return NextResponse.json({
    ok: true,
    status,
    finished: status === "done" || status === "failed",
    onlineStatus: onlineChipStatus(online.check, job.status),
    lastCheckedAt: online.lastCheckedAt ?? job.finishedAt,
  });
}
