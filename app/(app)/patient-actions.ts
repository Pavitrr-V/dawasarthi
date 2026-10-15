"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { SELECTED_PATIENT_COOKIE } from "@/lib/constants";
import { removeUserStorage } from "@/lib/storage";

export type PatientFormState = { error?: string } | undefined;
export type DeleteDataResult = { error?: string };

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  secure: process.env.NODE_ENV === "production",
} as const;

const TimeSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .regex(/^\d{2}:\d{2}$/, { error: "Use HH:MM." })
    .optional()
);

const PatientSchema = z.object({
  name: z.string().trim().min(1, { error: "Name is required." }).max(80),
  age: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce
      .number()
      .int({ error: "Age must be a whole number." })
      .min(0, { error: "Age must be between 0 and 150." })
      .max(150, { error: "Age must be between 0 and 150." })
      .optional()
  ),
  allergies: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  conditions: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  breakfast_time: TimeSchema,
  lunch_time: TimeSchema,
  dinner_time: TimeSchema,
});

/** Create or update a patient profile owned by the signed-in account. */
export async function savePatient(
  _state: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const user = await requireUser();

  const parsed = PatientSchema.safeParse({
    name: formData.get("name"),
    age: formData.get("age"),
    allergies: formData.getAll("allergies"),
    conditions: formData.getAll("conditions"),
    breakfast_time: formData.get("breakfast_time"),
    lunch_time: formData.get("lunch_time"),
    dinner_time: formData.get("dinner_time"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const id = String(formData.get("id") ?? "").trim();
  const record = {
    owner_user_id: user.id,
    name: parsed.data.name,
    age: parsed.data.age ?? null,
    allergies: parsed.data.allergies,
    conditions: parsed.data.conditions,
    breakfast_time: parsed.data.breakfast_time ?? null,
    lunch_time: parsed.data.lunch_time ?? null,
    dinner_time: parsed.data.dinner_time ?? null,
  };

  const supabase = await createClient();

  if (id) {
    const { error } = await supabase
      .from("patients")
      .update(record)
      .eq("id", id)
      .eq("owner_user_id", user.id);

    if (error) return { error: "Could not save changes. Please try again." };
  } else {
    const { data, error } = await supabase
      .from("patients")
      .insert(record)
      .select("id")
      .single();

    if (error || !data) {
      console.error("[savePatient] insert failed", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
        values: record,
      });
      return { error: "Could not create the profile. Please try again." };
    }

    (await cookies()).set(SELECTED_PATIENT_COOKIE, data.id, COOKIE_OPTIONS);
  }

  revalidatePath("/", "layout");
  redirect("/profile");
}

/** Delete a single patient profile owned by the signed-in account. */
export async function deletePatient(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const supabase = await createClient();
  await supabase
    .from("patients")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", user.id);

  const store = await cookies();
  if (store.get(SELECTED_PATIENT_COOKIE)?.value === id) {
    store.delete(SELECTED_PATIENT_COOKIE);
  }

  revalidatePath("/", "layout");
  redirect("/profile");
}

/** Switch the active profile shown across the app. */
export async function setSelectedPatient(patientId: string): Promise<void> {
  const user = await requireUser();

  const supabase = await createClient();
  const { data } = await supabase
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .eq("owner_user_id", user.id)
    .maybeSingle();

  if (!data) return;

  (await cookies()).set(SELECTED_PATIENT_COOKIE, data.id, COOKIE_OPTIONS);
  revalidatePath("/", "layout");
}

/**
 * Permanently delete everything for the signed-in account: storage files,
 * all database rows (via delete_all_my_data()), then sign out.
 */
export async function deleteAllMyData(): Promise<DeleteDataResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: patients } = await supabase
    .from("patients")
    .select("id")
    .eq("owner_user_id", user.id);
  const patientIds = (patients ?? []).map((p) => p.id as string);

  await removeUserStorage(supabase, user.id, patientIds);

  const { error } = await supabase.rpc("delete_all_my_data");
  if (error) {
    return { error: "Could not delete your data. Please try again." };
  }

  await supabase.auth.signOut();

  const store = await cookies();
  store.delete(SELECTED_PATIENT_COOKIE);

  redirect("/login");
}
