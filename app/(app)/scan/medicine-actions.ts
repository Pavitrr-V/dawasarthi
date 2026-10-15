"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { getSelectedPatient } from "@/lib/patients";
import {
  flaggedFields,
  medicineInputSchema,
  type MedicineInput,
} from "@/lib/medicine";

export type SaveMedicineResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Saves a reviewed/manual medicine for the currently selected patient profile.
 * The client then redirects to /medicine/[id] and fires /api/verify/start
 * (Phase 3B) without waiting for it.
 */
export async function saveMedicine(
  input: MedicineInput
): Promise<SaveMedicineResult> {
  const user = await requireUser();

  if (user.role !== "patient") {
    return { ok: false, error: "Only a patient account can add medicines." };
  }

  const patient = await getSelectedPatient();
  if (!patient) {
    return {
      ok: false,
      error: "Add a patient profile before saving a medicine.",
    };
  }

  const parsed = medicineInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }
  const data = parsed.data;

  // Image paths come from the client: only accept files in this user's own
  // storage folder, exactly like /api/extract does before downloading them.
  for (const path of [data.strip_image_path, data.box_image_path]) {
    if (path && !path.startsWith(`${user.id}/`)) {
      return { ok: false, error: "That photo does not belong to your account." };
    }
  }

  const supabase = await createClient();

  const { data: inserted, error } = await supabase
    .from("medicines")
    .insert({
      patient_id: patient.id,
      name: data.name,
      composition: data.composition,
      batch_no: data.batch_no,
      mfg_date: data.mfg_date,
      expiry_date: data.expiry_date,
      mrp: data.mrp ?? null,
      license_no: data.license_no,
      barcode: data.barcode_text,
      manufacturer: data.manufacturer,
      strip_image_path: data.strip_image_path,
      box_image_path: data.box_image_path,
      // TODO(Phase 3): lib/risk.ts does not exist yet, so the deterministic
      // rules engine cannot produce a verdict here. The column is
      // `not null check (risk_level in ('green','amber','red'))`, so we store
      // the amber placeholder and mark the row as pending. Replace both with
      // the real verdict + reasons once the engine ships.
      risk_level: "amber", // TODO(Phase 3): risk_level from lib/risk.ts.
      risk_reasons: [], // TODO(Phase 3): risk_reasons from lib/risk.ts.
      info: {
        confidence: data.confidence,
        verify_fields: flaggedFields(data.confidence),
        scan_mode: data.mode,
        source: data.source,
        storage_notes: data.storage_notes,
        // Barcode flow only: false = the code did not match medicine_catalog,
        // which Phase 3 should treat as an AMBER risk flag.
        ...(typeof data.dataset_match === "boolean"
          ? { dataset_match: data.dataset_match }
          : {}),
        // TODO(Phase 3B): /api/verify/start will move this through
        // queued -> running -> done and fill online_verifications.
        verify_status: "pending",
      },
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error("[saveMedicine] insert failed", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
    });
    return { ok: false, error: "Could not save the medicine. Please try again." };
  }

  revalidatePath("/", "layout");
  return { ok: true, id: inserted.id as string };
}
