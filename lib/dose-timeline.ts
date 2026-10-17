import { createClient } from "@/lib/supabase/server";
import {
  addDays,
  courseLabel,
  istStartOfDay,
  istToday,
  type DaysPattern,
} from "@/lib/schedule";
import type { AsNeededMedicine, DoseStatus, TimelineDose } from "@/lib/types";

/**
 * Read helpers for the home screen. Server-only: they use the caller's own
 * Supabase client, so RLS keeps every query scoped to the signed-in patient.
 * The caller has already resolved (and therefore verified ownership of) the
 * selected patient profile.
 */

/** Every dose scheduled for the selected patient today (Asia/Kolkata). */
export async function getTodayTimeline(
  patientId: string
): Promise<TimelineDose[]> {
  const supabase = await createClient();
  const today = istToday();
  const dayStart = istStartOfDay(today);
  const dayEnd = istStartOfDay(addDays(today, 1));

  const { data: doses } = await supabase
    .from("dose_logs")
    .select("id, schedule_id, due_at, status, acted_at")
    .eq("patient_id", patientId)
    .gte("due_at", dayStart)
    .lt("due_at", dayEnd)
    .order("due_at", { ascending: true });

  if (!doses || doses.length === 0) return [];

  const scheduleIds = [...new Set(doses.map((d) => d.schedule_id as string))];
  const { data: schedules } = await supabase
    .from("schedules")
    .select("id, medicine_id, days_pattern, start_date, duration_days")
    .in("id", scheduleIds);

  const scheduleById = new Map(
    (schedules ?? []).map((row) => [row.id as string, row])
  );

  const medicineIds = [
    ...new Set(
      (schedules ?? [])
        .map((row) => row.medicine_id as string)
        .filter(Boolean)
    ),
  ];
  const { data: medicines } =
    medicineIds.length > 0
      ? await supabase.from("medicines").select("id, name").in("id", medicineIds)
      : { data: [] as { id: string; name: string }[] };

  const nameById = new Map(
    (medicines ?? []).map((row) => [row.id as string, row.name as string])
  );

  return doses.map((dose) => {
    const schedule = scheduleById.get(dose.schedule_id as string);
    const medicineId = schedule?.medicine_id as string | undefined;
    const course = schedule
      ? courseLabel({
          days_pattern: schedule.days_pattern as DaysPattern,
          start_date: schedule.start_date as string,
          duration_days: (schedule.duration_days as number | null) ?? null,
        })
      : null;

    return {
      id: dose.id as string,
      due_at: dose.due_at as string,
      status: dose.status as DoseStatus,
      acted_at: (dose.acted_at as string | null) ?? null,
      schedule_id: dose.schedule_id as string,
      days_pattern: (schedule?.days_pattern as DaysPattern) ?? "daily",
      medicine_name: (medicineId ? nameById.get(medicineId) : null) ?? "Medicine",
      course,
    };
  });
}

/** Distinct active as-needed medicines for the selected patient. */
export async function listAsNeededMedicines(
  patientId: string
): Promise<AsNeededMedicine[]> {
  const supabase = await createClient();

  const { data: schedules } = await supabase
    .from("schedules")
    .select("id, medicine_id")
    .eq("patient_id", patientId)
    .eq("days_pattern", "as_needed")
    .eq("active", true);

  if (!schedules || schedules.length === 0) return [];

  const medicineIds = [
    ...new Set(schedules.map((row) => row.medicine_id as string)),
  ];
  const { data: medicines } = await supabase
    .from("medicines")
    .select("id, name")
    .in("id", medicineIds);

  const nameById = new Map(
    (medicines ?? []).map((row) => [row.id as string, row.name as string])
  );

  const seen = new Set<string>();
  const items: AsNeededMedicine[] = [];
  for (const schedule of schedules) {
    const medicineId = schedule.medicine_id as string;
    if (seen.has(medicineId)) continue;
    seen.add(medicineId);
    items.push({
      schedule_id: schedule.id as string,
      medicine_id: medicineId,
      name: nameById.get(medicineId) ?? "Medicine",
    });
  }
  return items;
}

/** Everything the home screen needs, fetched in parallel. */
export async function getHomeData(patientId: string): Promise<{
  doses: TimelineDose[];
  asNeeded: AsNeededMedicine[];
}> {
  const [doses, asNeeded] = await Promise.all([
    getTodayTimeline(patientId),
    listAsNeededMedicines(patientId),
  ]);
  return { doses, asNeeded };
}
