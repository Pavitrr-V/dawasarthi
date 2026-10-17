"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_DURATION_DAYS,
  MAX_TIMES,
  generateDoses,
  normalizeTimes,
  normalizeWeekdays,
  parseIsoDate,
  resolveMealTime,
  type DaysPattern,
  type MealLink,
} from "@/lib/schedule";

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

const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export type ReminderInput = {
  medicineId: string;
  /** Explicit clock times ("HH:MM"); may be empty when a meal link is set. */
  times: string[];
  daysPattern: DaysPattern;
  /** 0 = Sunday … 6 = Saturday; only used for the "weekdays" pattern. */
  weekdays: number[];
  mealLink: MealLink | null;
  /** "YYYY-MM-DD" in the patient's timezone. */
  startDate: string;
  /** null = ongoing. */
  durationDays: number | null;
};

const reminderSchema = z.object({
  medicineId: medicineIdSchema,
  times: z.array(hhmmSchema).max(MAX_TIMES),
  daysPattern: z.enum(["daily", "alternate", "weekdays", "as_needed"]),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  mealLink: z
    .enum([
      "before_breakfast",
      "after_breakfast",
      "before_lunch",
      "after_lunch",
      "before_dinner",
      "after_dinner",
    ])
    .nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationDays: z.number().int().min(1).max(MAX_DURATION_DAYS).nullable(),
});

/**
 * Creates a schedule and materialises the first week of `dose_logs`.
 *
 * The schedule id is generated up front so the dose rows can reference it
 * without a `.select()` after insert (the schedules SELECT policy goes through
 * a helper function and cannot be relied on to echo the row back). Doses are
 * written with an upsert that ignores duplicates on `(schedule_id, due_at)`,
 * backed by the `dose_logs_schedule_due_uniq` unique index.
 */
export async function createReminder(
  input: ReminderInput
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return { ok: false, error: "Please sign in again." };
  }

  const parsed = reminderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please check the reminder details." };
  }
  const data = parsed.data;

  // `parseIsoDate` rejects impossible dates (e.g. 2026-02-30) that the regex
  // above would accept.
  if (!parseIsoDate(data.startDate)) {
    return { ok: false, error: "Pick a valid start date." };
  }

  const owned = await ownedMedicinePatientId(data.medicineId);
  if ("error" in owned) return { ok: false, error: owned.error };

  const supabase = await createClient();

  // Resolve the optional meal link against this patient's own meal times; the
  // resolved clock time is merged into `times` so the schedule is
  // self-contained for dose generation.
  const mealLink = data.mealLink;
  let resolvedTime: string | null = null;
  if (mealLink) {
    const { data: patientRow } = await supabase
      .from("patients")
      .select("breakfast_time, lunch_time, dinner_time")
      .eq("id", owned.patientId)
      .maybeSingle();
    resolvedTime = resolveMealTime(mealLink, {
      breakfast: patientRow?.breakfast_time ?? null,
      lunch: patientRow?.lunch_time ?? null,
      dinner: patientRow?.dinner_time ?? null,
    });
  }

  const times = normalizeTimes([
    ...data.times,
    ...(resolvedTime ? [resolvedTime] : []),
  ]);
  if (data.daysPattern !== "as_needed" && times.length === 0) {
    return { ok: false, error: "Pick at least one reminder time." };
  }
  if (data.daysPattern === "weekdays" && data.weekdays.length === 0) {
    return { ok: false, error: "Pick at least one day of the week." };
  }

  const weekdays =
    data.daysPattern === "weekdays" ? normalizeWeekdays(data.weekdays) : [];

  const scheduleId = crypto.randomUUID();
  const { error: scheduleError } = await supabase.from("schedules").insert({
    id: scheduleId,
    medicine_id: data.medicineId,
    patient_id: owned.patientId,
    // Postgres `time[]` accepts "HH:MM:SS" strings.
    times: times.map((time) => `${time}:00`),
    days_pattern: data.daysPattern,
    weekdays,
    meal_link: mealLink,
    start_date: data.startDate,
    duration_days: data.durationDays,
    active: true,
  });

  if (scheduleError) {
    return { ok: false, error: "Could not set the reminder. Please try again." };
  }

  const doses = generateDoses(
    {
      id: scheduleId,
      patient_id: owned.patientId,
      times,
      days_pattern: data.daysPattern,
      weekdays,
      start_date: data.startDate,
      duration_days: data.durationDays,
    },
    7
  );

  if (doses.length > 0) {
    const { error: doseError } = await supabase
      .from("dose_logs")
      .upsert(doses, {
        onConflict: "schedule_id,due_at",
        ignoreDuplicates: true,
      });
    if (doseError) {
      // Keep the two writes consistent: drop the orphaned schedule.
      await supabase.from("schedules").delete().eq("id", scheduleId);
      return { ok: false, error: "Could not set the reminder. Please try again." };
    }
  }

  revalidatePath(`/medicine/${data.medicineId}`);
  revalidatePath("/home");
  revalidatePath("/history");

  return {
    ok: true,
    message:
      doses.length > 0
        ? "Reminder set. We will nudge you and track each dose."
        : "Reminder set. We will nudge you when needed.",
  };
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
