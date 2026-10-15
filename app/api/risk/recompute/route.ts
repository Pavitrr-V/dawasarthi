import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateRisk } from "@/lib/risk";
import {
  buildRiskContext,
  MEDICINE_RISK_COLUMNS,
  type MedicineRiskRow,
} from "@/lib/risk-data";

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
  const medicineId = parsed.data.medicine_id;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("medicines")
    .select(MEDICINE_RISK_COLUMNS)
    .eq("id", medicineId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json(
      { error: "Medicine not found." },
      { status: 404 }
    );
  }
  const medicine = data as unknown as MedicineRiskRow;

  // Optional: the community total needs the service role. Without the key we
  // simply skip it (0 reports) instead of failing the request.
  let admin = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  const context = await buildRiskContext({ supabase, medicine, admin });
  const result = evaluateRisk(context.input);

  const { error: updateError } = await supabase
    .from("medicines")
    .update({
      risk_level: result.level,
      risk_reasons: result.reasons,
    })
    .eq("id", medicineId);

  if (updateError) {
    // Still return the fresh verdict so the UI can update even if the write
    // failed (for example a read-only replica); we just cannot persist it.
    return NextResponse.json({
      ok: false,
      error: "Could not save the result.",
      level: result.level,
      reasons: result.reasons,
      alertCount: context.alertMatches.length,
      onlineStatus: context.onlineStatus,
      jobStatus: context.jobStatus,
      lastCheckedAt: context.lastCheckedAt,
      communityReportCount: context.communityReportCount,
    });
  }

  return NextResponse.json({
    ok: true,
    level: result.level,
    reasons: result.reasons,
    alertCount: context.alertMatches.length,
    onlineStatus: context.onlineStatus,
    jobStatus: context.jobStatus,
    lastCheckedAt: context.lastCheckedAt,
    communityReportCount: context.communityReportCount,
  });
}
