import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { SNOOZE_MINUTES, snoozeDueAt } from "@/lib/schedule";
import type { DoseStatus } from "@/lib/types";

/**
 * Dose reads and writes. Server-only: it touches the service-role client and
 * the push path, so never import it from a client component.
 *
 * The push-notification action path has no session, so ownership is proved
 * explicitly here (a dose may only be changed when it belongs to a patient
 * profile owned by `userId`) instead of relying on RLS. The in-app path passes
 * the caller's own client, where RLS applies on top of the same check.
 *
 * Dose action model
 * -----------------
 *  taken   -> status 'taken',   acted_at = now, stock decremented by DOSE_COUNT
 *  skipped -> status 'skipped', acted_at = now
 *  snooze  -> status 'snoozed', due_at = max(due_at, now) + 10 min,
 *             acted_at = now. The dose is *not* final: the reminder loop
 *             treats 'pending' and 'snoozed' alike (see ALERTABLE_STATUSES),
 *             so it fires again when the new `due_at` arrives.
 */

export const DOSE_ACTIONS = ["taken", "skipped", "snooze"] as const;
export type DoseAction = (typeof DOSE_ACTIONS)[number];

/** Statuses that are still waiting for the patient to act (so still alertable). */
export const ALERTABLE_STATUSES: readonly DoseStatus[] = ["pending", "snoozed"];

/** Tablets removed from stock each time a dose is confirmed as taken. */
export const DOSE_COUNT = 1;

export { SNOOZE_MINUTES };

const STATUS_BY_ACTION: Record<DoseAction, "taken" | "skipped" | "snoozed"> = {
  taken: "taken",
  skipped: "skipped",
  snooze: "snoozed",
};

export type ApplyDoseActionResult =
  | {
      ok: true;
      doseId: string;
      status: "taken" | "skipped" | "snoozed";
      dueAt: string;
      /** Stock left after a "taken" action, or null when there is no stock row. */
      inventoryLeft: number | null;
    }
  | { ok: false; error: string; httpStatus: number };

export type LogAdHocDoseResult =
  | { ok: true; doseId: string; inventoryLeft: number | null }
  | { ok: false; error: string; httpStatus: number };

type DoseRow = {
  id: string;
  patient_id: string;
  schedule_id: string;
  due_at: string;
  status: string;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Logs a Supabase error's message and code only — never row data or keys. */
function logSupabaseError(
  context: string,
  error: { message: string; code?: string }
): void {
  console.error(`[doses] ${context}`, {
    message: error.message,
    code: error.code,
  });
}

/** The patient id when it is owned by `userId`, otherwise null. */
async function ownedPatientId(
  supabase: SupabaseClient,
  patientId: string,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .eq("owner_user_id", userId)
    .maybeSingle();

  if (error) {
    // Fail closed rather than misreporting a DB failure as "not owned".
    logSupabaseError("could not verify patient ownership", error);
    throw new Error("Could not verify that this patient belongs to you.");
  }

  return (data?.id as string | undefined) ?? null;
}

/**
 * Removes `count` from a medicine's stock, floored at zero. Stock is a nicety:
 * a missing row or a failed write never fails the dose action. Returns the new
 * quantity, or null when there is nothing to update.
 */
async function decrementInventory(
  supabase: SupabaseClient,
  medicineId: string,
  count: number
): Promise<number | null> {
  if (count <= 0) return null;

  const { data, error } = await supabase
    .from("inventory")
    .select("quantity_left")
    .eq("medicine_id", medicineId)
    .maybeSingle();
  if (error) {
    logSupabaseError("could not read inventory", error);
    return null;
  }
  if (!data) return null;

  const current = (data.quantity_left as number | null) ?? 0;
  const next = Math.max(0, current - count);
  const { data: updated, error: updateError } = await supabase
    .from("inventory")
    .update({ quantity_left: next })
    .eq("medicine_id", medicineId)
    .select("quantity_left");

  if (updateError) {
    logSupabaseError("could not update inventory", updateError);
    return null;
  }

  const saved = updated?.[0]?.quantity_left;
  return typeof saved === "number" ? saved : next;
}

// ---------------------------------------------------------------------------
// Next pending dose (used to attach action buttons to a test notification)
// ---------------------------------------------------------------------------

export type NextPendingDose = {
  id: string;
  dueAt: string;
  medicineName: string | null;
};

/**
 * Returns the next dose still waiting for the patient across every profile
 * owned by `userId`, with the medicine name when it can be resolved.
 */
export async function findNextPendingDose(
  userId: string,
  admin: SupabaseClient = createAdminClient()
): Promise<NextPendingDose | null> {
  const { data: patients, error: patientsError } = await admin
    .from("patients")
    .select("id")
    .eq("owner_user_id", userId);

  if (patientsError) {
    logSupabaseError("could not list patient profiles", patientsError);
    throw new Error("Could not look up your doses.");
  }

  const patientIds = (patients ?? []).map((row) => row.id as string);
  if (patientIds.length === 0) return null;

  const { data: dose, error: doseError } = await admin
    .from("dose_logs")
    .select("id, due_at, schedule_id")
    .in("patient_id", patientIds)
    .in("status", [...ALERTABLE_STATUSES])
    .order("due_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (doseError) {
    logSupabaseError("could not read the next pending dose", doseError);
    throw new Error("Could not look up your next dose.");
  }
  if (!dose) return null;

  // The medicine name is only enrichment for the notification body: a failed
  // lookup degrades to a generic message instead of aborting.
  let medicineName: string | null = null;

  const { data: schedule, error: scheduleError } = await admin
    .from("schedules")
    .select("medicine_id")
    .eq("id", dose.schedule_id)
    .maybeSingle();

  if (scheduleError) {
    logSupabaseError("could not read the dose's schedule", scheduleError);
  } else if (schedule?.medicine_id) {
    const { data: medicine, error: medicineError } = await admin
      .from("medicines")
      .select("name")
      .eq("id", schedule.medicine_id)
      .maybeSingle();
    if (medicineError) {
      logSupabaseError("could not read the medicine name", medicineError);
    }
    medicineName = (medicine?.name as string | undefined) ?? null;
  }

  return {
    id: dose.id as string,
    dueAt: dose.due_at as string,
    medicineName,
  };
}

// ---------------------------------------------------------------------------
// Apply a dose action
// ---------------------------------------------------------------------------

export async function applyDoseAction(
  {
    doseId,
    userId,
    action,
  }: { doseId: string; userId: string; action: DoseAction },
  admin: SupabaseClient = createAdminClient()
): Promise<ApplyDoseActionResult> {
  const { data, error } = await admin
    .from("dose_logs")
    .select("id, patient_id, schedule_id, due_at, status")
    .eq("id", doseId)
    .maybeSingle();

  if (error) {
    logSupabaseError("could not read dose", error);
    return { ok: false, error: "Could not look up that dose.", httpStatus: 500 };
  }
  if (!data) {
    return { ok: false, error: "We could not find that dose.", httpStatus: 404 };
  }
  const dose = data as unknown as DoseRow;

  if (!(await ownedPatientId(admin, dose.patient_id, userId))) {
    return {
      ok: false,
      error: "You cannot change this dose.",
      httpStatus: 403,
    };
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // --- Snooze: move the dose 10 minutes out and re-enter the alert loop. -----
  if (action === "snooze") {
    const dueAt = snoozeDueAt(dose.due_at, now);
    const { data: updated, error: updateError } = await admin
      .from("dose_logs")
      .update({ status: "snoozed", due_at: dueAt, acted_at: nowIso })
      .eq("id", doseId)
      .select("id");

    if (updateError) {
      // The moved `due_at` collided with another dose for the same schedule
      // (unique on `(schedule_id, due_at)`). Keep the snooze status without
      // moving the time rather than failing the tap.
      if (updateError.code === "23505") {
        const { data: fallback, error: fallbackError } = await admin
          .from("dose_logs")
          .update({ status: "snoozed", acted_at: nowIso })
          .eq("id", doseId)
          .select("id");
        if (fallbackError) {
          logSupabaseError("could not snooze dose (fallback)", fallbackError);
          return {
            ok: false,
            error: "Could not update the dose.",
            httpStatus: 500,
          };
        }
        if (!fallback?.length) {
          return {
            ok: false,
            error: "Could not update the dose.",
            httpStatus: 500,
          };
        }
        return {
          ok: true,
          doseId,
          status: "snoozed",
          dueAt: dose.due_at,
          inventoryLeft: null,
        };
      }
      logSupabaseError("could not snooze dose", updateError);
      return { ok: false, error: "Could not update the dose.", httpStatus: 500 };
    }
    if (!updated?.length) {
      return { ok: false, error: "Could not update the dose.", httpStatus: 500 };
    }

    return { ok: true, doseId, status: "snoozed", dueAt, inventoryLeft: null };
  }

  // --- Taken / skipped: final for today (until the next scheduled dose). -----
  const status = STATUS_BY_ACTION[action];
  const { data: updated, error: updateError } = await admin
    .from("dose_logs")
    .update({ status, acted_at: nowIso })
    .eq("id", doseId)
    .select("id");

  if (updateError) {
    logSupabaseError("could not update dose", updateError);
    return { ok: false, error: "Could not update the dose.", httpStatus: 500 };
  }
  if (!updated?.length) {
    return { ok: false, error: "Could not update the dose.", httpStatus: 500 };
  }

  // Only decrement stock on the transition into "taken", so a double tap (or a
  // realtime echo) can never remove a second tablet.
  let inventoryLeft: number | null = null;
  if (action === "taken" && dose.status !== "taken") {
    const { data: schedule, error: scheduleError } = await admin
      .from("schedules")
      .select("medicine_id")
      .eq("id", dose.schedule_id)
      .maybeSingle();
    if (scheduleError) {
      // Stock is best-effort; a failed lookup must not undo the "taken" action.
      logSupabaseError("could not read the dose's schedule", scheduleError);
    } else if (schedule?.medicine_id) {
      inventoryLeft = await decrementInventory(
        admin,
        schedule.medicine_id as string,
        DOSE_COUNT
      );
    }
  }

  return { ok: true, doseId, status, dueAt: dose.due_at, inventoryLeft };
}

// ---------------------------------------------------------------------------
// Ad-hoc dose (as-needed medicine, "Took one now")
// ---------------------------------------------------------------------------

/**
 * Logs an unscheduled dose for an as-needed schedule: a `dose_logs` row stamped
 * taken at the current time. Also decrements stock.
 */
export async function logAdHocDose(
  { scheduleId, userId }: { scheduleId: string; userId: string },
  supabase: SupabaseClient = createAdminClient()
): Promise<LogAdHocDoseResult> {
  const { data: schedule, error } = await supabase
    .from("schedules")
    .select("id, patient_id, medicine_id, days_pattern, active")
    .eq("id", scheduleId)
    .maybeSingle();

  if (error) {
    logSupabaseError("could not read the schedule", error);
    return { ok: false, error: "Could not look up that medicine.", httpStatus: 500 };
  }
  if (!schedule) {
    return { ok: false, error: "We could not find that medicine.", httpStatus: 404 };
  }
  if (schedule.days_pattern !== "as_needed") {
    return {
      ok: false,
      error: "That medicine is not set to as-needed.",
      httpStatus: 400,
    };
  }
  if (schedule.active === false) {
    return { ok: false, error: "That reminder is no longer active.", httpStatus: 400 };
  }

  const patientId = schedule.patient_id as string;
  if (!(await ownedPatientId(supabase, patientId, userId))) {
    return { ok: false, error: "You cannot log this dose.", httpStatus: 403 };
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await supabase
    .from("dose_logs")
    .insert({
      schedule_id: scheduleId,
      patient_id: patientId,
      due_at: now,
      status: "taken",
      acted_at: now,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    if (insertError?.code === "23505") {
      return {
        ok: false,
        error: "Just logged. Try again in a moment.",
        httpStatus: 409,
      };
    }
    if (insertError) {
      logSupabaseError("could not log the dose", insertError);
    }
    return { ok: false, error: "Could not log that dose.", httpStatus: 500 };
  }

  const inventoryLeft = schedule.medicine_id
    ? await decrementInventory(
        supabase,
        schedule.medicine_id as string,
        DOSE_COUNT
      )
    : null;

  return { ok: true, doseId: inserted.id as string, inventoryLeft };
}
