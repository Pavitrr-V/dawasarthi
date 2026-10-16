import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateRisk, type RiskResult } from "@/lib/risk";
import {
  buildRiskContext,
  MEDICINE_RISK_COLUMNS,
  type MedicineRiskContext,
  type MedicineRiskRow,
} from "@/lib/risk-data";

/**
 * Server-only helper that recomputes and persists one medicine's deterministic
 * risk verdict. It is the single code path shared by:
 *   - POST /api/risk/recompute (the trust card's live refresh), and
 *   - the scan/manual save action, right after a medicine is inserted.
 *
 * `recomputeMedicineRisk` runs with the *caller's* Supabase client, so RLS
 * enforces ownership: a user can only read/update their own medicine.
 * `recomputeMedicineRiskWith` accepts any client (e.g. the service-role client
 * used by the verify cron) so finishing a background job can recompute too.
 * Both return null when the medicine does not exist or is not visible.
 */

export type RecomputeOutcome = {
  result: RiskResult;
  context: MedicineRiskContext;
  /** False when the verdict was computed but the row update failed. */
  saved: boolean;
};

/** Recomputes using an explicit client (RLS still applies to non-admin ones). */
export async function recomputeMedicineRiskWith(
  supabase: SupabaseClient,
  medicineId: string
): Promise<RecomputeOutcome | null> {
  const { data, error } = await supabase
    .from("medicines")
    .select(MEDICINE_RISK_COLUMNS)
    .eq("id", medicineId)
    .maybeSingle();

  if (error || !data) return null;
  const medicine = data as unknown as MedicineRiskRow;

  // The community total needs the service role; without the key we simply skip
  // it (0 reports) instead of failing the whole recompute.
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

  return { result, context, saved: !updateError };
}

export async function recomputeMedicineRisk(
  medicineId: string
): Promise<RecomputeOutcome | null> {
  const supabase = await createClient();
  return recomputeMedicineRiskWith(supabase, medicineId);
}
