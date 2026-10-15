import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SELECTED_PATIENT_COOKIE } from "@/lib/constants";
import type { PatientOption, PatientProfile } from "@/lib/types";

const PATIENT_COLUMNS =
  "id, name, age, allergies, conditions, breakfast_time, lunch_time, dinner_time";

/** All patient profiles owned by the signed-in account. */
export async function listPatientProfiles(): Promise<PatientProfile[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("patients")
    .select(PATIENT_COLUMNS)
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: true });

  return (data ?? []) as PatientProfile[];
}

/** A single profile, only if this account owns it. */
export async function getOwnedPatient(
  id: string
): Promise<PatientProfile | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("patients")
    .select(PATIENT_COLUMNS)
    .eq("id", id)
    .eq("owner_user_id", user.id)
    .maybeSingle();

  return (data as PatientProfile | null) ?? null;
}

/**
 * Profiles for the switcher plus the currently selected one.
 * Selection comes from a cookie and always falls back to the first profile.
 */
export async function getPatientContext(): Promise<{
  patients: PatientOption[];
  selected: PatientOption | null;
}> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return { patients: [], selected: null };
  }

  const profiles = await listPatientProfiles();
  const patients: PatientOption[] = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    age: p.age,
  }));

  if (patients.length === 0) return { patients, selected: null };

  const selectedId = (await cookies()).get(SELECTED_PATIENT_COOKIE)?.value;
  const selected =
    patients.find((p) => p.id === selectedId) ?? patients[0];

  return { patients, selected };
}

/** Resolve the selected profile in a page/layout. */
export async function getSelectedPatient(): Promise<PatientProfile | null> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") return null;

  const profiles = await listPatientProfiles();
  if (profiles.length === 0) return null;

  const selectedId = (await cookies()).get(SELECTED_PATIENT_COOKIE)?.value;
  return profiles.find((p) => p.id === selectedId) ?? profiles[0];
}
