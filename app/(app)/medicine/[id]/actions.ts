"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const medicineIdSchema = z.string().uuid();

/** Confirms the medicine exists and belongs to a profile this user owns. */
async function ownedMedicinePatientId(
  medicineId: string
): Promise<{ patientId: string } | { error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("medicines")
    .select("patient_id")
    .eq("id", medicineId)
    .maybeSingle();

  if (error || !data) {
    return { error: "We could not find that medicine." };
  }

  // RLS only returns medicines this user can see; a caregiver (consented,
  // SELECT-only) must not write. Enforce the owner role here too.
  const { data: patient } = await supabase
    .from("patients")
    .select("id")
    .eq("id", data.patient_id)
    .eq("owner_user_id", (await getCurrentUser())?.id ?? "")
    .maybeSingle();

  if (!patient) {
    return { error: "You can only change your own medicines." };
  }

  return { patientId: patient.id as string };
}

// ---------------------------------------------------------------------------
// Add to cabinet
// ---------------------------------------------------------------------------

export async function addToCabinet(
  medicineId: string,
  quantity: number
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return { ok: false, error: "Please sign in again." };
  }

  const idParsed = medicineIdSchema.safeParse(medicineId);
  const quantityParsed = z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .safeParse(quantity);
  if (!idParsed.success || !quantityParsed.success) {
    return { ok: false, error: "Enter how many tablets you have." };
  }

  const owned = await ownedMedicinePatientId(idParsed.data);
  if ("error" in owned) return { ok: false, error: owned.error };

  const supabase = await createClient();
  // inventory.medicine_id is unique, so upsert keeps one stock row per medicine.
  const { error } = await supabase.from("inventory").upsert(
    {
      medicine_id: idParsed.data,
      quantity_left: quantityParsed.data,
      unit: "tablets",
    },
    { onConflict: "medicine_id" }
  );

  if (error) {
    return { ok: false, error: "Could not save your stock. Please try again." };
  }

  revalidatePath(`/medicine/${idParsed.data}`);
  revalidatePath("/cabinet");
  return {
    ok: true,
    message: `Saved ${quantityParsed.data} tablet${
      quantityParsed.data === 1 ? "" : "s"
    } to your cabinet.`,
  };
}

// ---------------------------------------------------------------------------
// Report suspicious medicine
// ---------------------------------------------------------------------------

export async function reportSuspiciousMedicine(
  medicineId: string,
  note: string
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  const idParsed = medicineIdSchema.safeParse(medicineId);
  const noteParsed = z.string().trim().max(500).safeParse(note);
  if (!idParsed.success || !noteParsed.success) {
    return { ok: false, error: "That report is too long." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("reports").insert({
    medicine_id: idParsed.data,
    reporter_user_id: user.id,
    note: noteParsed.data.length > 0 ? noteParsed.data : null,
  });

  if (error) {
    return { ok: false, error: "Could not send your report. Please try again." };
  }

  revalidatePath(`/medicine/${idParsed.data}`);
  return {
    ok: true,
    message: "Thank you. Your report helps other people.",
  };
}

// ---------------------------------------------------------------------------
// Set reminder
// ---------------------------------------------------------------------------

const timesSchema = z
  .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
  .min(1)
  .max(6);

export async function createReminder(
  medicineId: string,
  times: string[]
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return { ok: false, error: "Please sign in again." };
  }

  const idParsed = medicineIdSchema.safeParse(medicineId);
  const timesParsed = timesSchema.safeParse(times);
  if (!idParsed.success || !timesParsed.success) {
    return { ok: false, error: "Pick at least one reminder time." };
  }

  const owned = await ownedMedicinePatientId(idParsed.data);
  if ("error" in owned) return { ok: false, error: owned.error };

  const supabase = await createClient();
  const { error } = await supabase.from("schedules").insert({
    medicine_id: idParsed.data,
    patient_id: owned.patientId,
    // Postgres `time[]` accepts "HH:MM:SS" strings.
    times: timesParsed.data.map((time) => `${time}:00`),
    days_pattern: "daily",
    active: true,
  });

  if (error) {
    return { ok: false, error: "Could not set the reminder. Please try again." };
  }

  revalidatePath(`/medicine/${idParsed.data}`);
  return { ok: true, message: "Reminder set. We will nudge you at these times." };
}

// ---------------------------------------------------------------------------
// Scan other side
// ---------------------------------------------------------------------------

const sideFieldsSchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    batch_no: z.string().trim().max(60).nullable().optional(),
    expiry_date: z.string().trim().max(20).nullable().optional(),
  })
  .partial();

/**
 * Attaches a photo of the other face of the pack to an existing medicine and
 * records the (best-effort) fields read from it under `info.second_side`, so
 * the risk engine can cross-check strip vs box on the next recompute.
 */
export async function attachSidePhoto(
  medicineId: string,
  side: "strip" | "box",
  imagePath: string,
  fields: z.infer<typeof sideFieldsSchema> | null
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return { ok: false, error: "Please sign in again." };
  }

  const idParsed = medicineIdSchema.safeParse(medicineId);
  if (!idParsed.success) {
    return { ok: false, error: "Unknown medicine." };
  }
  if (side !== "strip" && side !== "box") {
    return { ok: false, error: "Unknown side." };
  }
  // The uploaded file must live in this user's own storage folder.
  if (!imagePath.startsWith(`${user.id}/`)) {
    return { ok: false, error: "That photo does not belong to your account." };
  }

  const parsedFields = sideFieldsSchema.safeParse(fields ?? {});
  if (!parsedFields.success) {
    return { ok: false, error: "We could not read that photo." };
  }

  const owned = await ownedMedicinePatientId(idParsed.data);
  if ("error" in owned) return { ok: false, error: owned.error };

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("medicines")
    .select("info")
    .eq("id", idParsed.data)
    .maybeSingle();
  if (readError || !current) {
    return { ok: false, error: "We could not find that medicine." };
  }

  const existingInfo =
    current.info && typeof current.info === "object" && !Array.isArray(current.info)
      ? (current.info as Record<string, unknown>)
      : {};

  const cleaned = {
    name: parsedFields.data.name ?? null,
    batch_no: parsedFields.data.batch_no ?? null,
    expiry_date: parsedFields.data.expiry_date ?? null,
  };
  const hasFields = Boolean(cleaned.name || cleaned.batch_no || cleaned.expiry_date);

  const { error: updateError } = await supabase
    .from("medicines")
    .update({
      ...(side === "strip"
        ? { strip_image_path: imagePath }
        : { box_image_path: imagePath }),
      info: {
        ...existingInfo,
        ...(hasFields ? { second_side: cleaned } : {}),
      },
    })
    .eq("id", idParsed.data);

  if (updateError) {
    return { ok: false, error: "Could not attach the photo. Please try again." };
  }

  revalidatePath(`/medicine/${idParsed.data}`);
  return { ok: true, message: "Photo added. Re-running the risk check…" };
}
