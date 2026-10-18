"use server";

import { createClient } from "@/lib/supabase/server";
import { runAllSafetyChecks } from "@/lib/safety";
import type { MedicineWithComp, PatientWithAllergies } from "@/lib/safety";
import { connection } from "next/server";

export async function runSafetyCheckForPatient(patientId: string) {
  await connection();
  const supabase = createClient();
  const { data: user } = await (await supabase).auth.getUser();
  if (!user?.user) throw new Error("Unauthorized");

  const { data: patient, error: pErr } = await (await supabase)
    .from("patients")
    .select("id, allergies")
    .eq("id", patientId)
    .single();
  if (pErr) {
    console.error(
      "[safety-check] patient error:",
      pErr.message,
      pErr.code
    );
    throw new Error(pErr.message || "Failed to load patient");
  }

  const { data: meds, error: mErr } = await (await supabase)
    .from("medicines")
    .select("id, name, composition, active")
    .eq("patient_id", patientId);
  if (mErr) {
    console.error(
      "[safety-check] medicines error:",
      mErr.message,
      mErr.code
    );
    throw new Error(mErr.message || "Failed to load medicines");
  }

  const res = await runAllSafetyChecks({
    patient: patient as PatientWithAllergies,
    medicines: (meds || []) as MedicineWithComp[],
  });
  return res;
}

export async function runSafetyCheckOnMedicineAdd(patientId: string) {
  return runSafetyCheckForPatient(patientId);
}

export async function runSafetyCheckOnScheduleCreate(patientId: string) {
  return runSafetyCheckForPatient(patientId);
}