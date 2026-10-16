import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { recomputeMedicineRisk } from "@/lib/risk-recompute";

const bodySchema = z.object({
  medicine_id: z.string().uuid(),
});

/**
 * Recomputes the deterministic risk verdict for one medicine and persists it
 * into medicines.risk_level / risk_reasons.
 *
 * The trust card calls this on mount and again whenever Realtime reports a new
 * online_verifications or tinyfish_jobs row, so the card colour updates live
 * as TinyFish finishes. The verdict itself is always decided by lib/risk.ts.
 * Ownership is enforced by RLS on the read/update inside the shared helper.
 */
export async function POST(request: Request) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A medicine id is required." },
      { status: 400 }
    );
  }

  const outcome = await recomputeMedicineRisk(parsed.data.medicine_id);
  if (!outcome) {
    return NextResponse.json({ error: "Medicine not found." }, { status: 404 });
  }

  const { result, context, saved } = outcome;

  return NextResponse.json({
    ok: saved,
    ...(saved ? {} : { error: "Could not save the result." }),
    level: result.level,
    reasons: result.reasons,
    alertCount: context.alertMatches.length,
    onlineStatus: context.onlineStatus,
    jobStatus: context.jobStatus,
    lastCheckedAt: context.lastCheckedAt,
    communityReportCount: context.communityReportCount,
  });
}
