import { createClient } from "@/lib/supabase/server";
import { getTodayTimeline } from "@/lib/dose-timeline";
import { computeAdherence } from "@/lib/adherence";
import { addDays, istStartOfDay, istToday } from "@/lib/schedule";
import {
  REASON_CODE_ALERT_BATCH_MATCH,
  type RiskLevel,
  type RiskReason,
} from "@/lib/risk";
import type { CaregiverLinkStatus } from "@/lib/caregiver";
import type {
  CaregiverHistoryRow,
  CaregiverLinkSummary,
  CaregiverMedicine,
  CaregiverPatient,
  CaregiverPatientSummary,
  DoseStatus,
} from "@/lib/types";

/**
 * Server-only data access for the caregiver dashboard.
 *
 * Every read uses the *signed-in user's* Supabase client, so RLS decides what a
 * caregiver can see: `public.can_view_patient` grants SELECT on patients,
 * medicines, schedules and dose_logs only for links with
 * `status = 'active' AND consent_given = true`. The service role is never used
 * here — revoking consent therefore removes data everywhere at once, with no
 * extra filtering needed on our side.
 *
 * Never import this module from a client component.
 */

const WEEK_DAYS = 7;

/**
 * Patients the caregiver is actively linked to (consent given), oldest link
 * first. Names come straight from the `patients` table via RLS.
 */
export async function listLinkedPatients(): Promise<CaregiverPatient[]> {
  const supabase = await createClient();

  const { data: links, error } = await supabase
    .from("caregiver_links")
    .select("patient_id, created_at")
    .eq("status", "active")
    .eq("consent_given", true)
    .order("created_at", { ascending: true });

  if (error || !links || links.length === 0) return [];

  const ids = [...new Set(links.map((link) => link.patient_id as string))];

  const { data: patients, error: patientsError } = await supabase
    .from("patients")
    .select("id, name")
    .in("id", ids);

  if (patientsError || !patients) return [];

  const nameById = new Map(
    patients.map((patient) => [patient.id as string, patient.name as string])
  );

  return ids
    .filter((id) => nameById.has(id))
    .map((id) => ({ id, name: nameById.get(id) as string }));
}

/**
 * The caregiver's own link rows (pending and active, never revoked), with a
 * patient name only when consent has been given. A pending link cannot read the
 * `patients` row under RLS, so `patient_name` stays null until approval.
 */
export async function listCaregiverLinkSummaries(): Promise<CaregiverLinkSummary[]> {
  const supabase = await createClient();

  const { data: links, error } = await supabase
    .from("caregiver_links")
    .select("id, status, consent_given, patient_id, created_at")
    .neq("status", "revoked")
    .order("created_at", { ascending: false });

  if (error || !links) return [];

  const activeIds = [
    ...new Set(
      links
        .filter((link) => link.status === "active" && link.consent_given)
        .map((link) => link.patient_id as string)
    ),
  ];

  const nameById = new Map<string, string>();
  if (activeIds.length > 0) {
    const { data: patients } = await supabase
      .from("patients")
      .select("id, name")
      .in("id", activeIds);
    for (const patient of patients ?? []) {
      nameById.set(patient.id as string, patient.name as string);
    }
  }

  return links.map((link) => ({
    id: link.id as string,
    status: link.status as CaregiverLinkStatus,
    consent_given: Boolean(link.consent_given),
    patient_id: link.patient_id as string,
    patient_name: nameById.get(link.patient_id as string) ?? null,
  }));
}

/**
 * Weekly adherence for one patient: taken / (taken + missed + skipped) over the
 * last 7 calendar days in Asia/Kolkata, including today. Pending and snoozed
 * doses are ignored (see lib/adherence.ts).
 */
export async function getWeeklyAdherence(patientId: string) {
  const supabase = await createClient();

  const today = istToday();
  const from = istStartOfDay(addDays(today, -(WEEK_DAYS - 1)));
  const to = istStartOfDay(addDays(today, 1));

  const { data, error } = await supabase
    .from("dose_logs")
    .select("status")
    .eq("patient_id", patientId)
    .gte("due_at", from)
    .lt("due_at", to)
    .in("status", ["taken", "missed", "skipped"]);

  if (error || !data) return computeAdherence([]);

  return computeAdherence(data.map((row) => row.status as DoseStatus));
}

/** A single linked patient's name, or null when RLS hides them (not consented). */
export async function getCaregiverPatient(
  patientId: string
): Promise<CaregiverPatient | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("patients")
    .select("id, name")
    .eq("id", patientId)
    .maybeSingle();

  if (error || !data) return null;
  return { id: data.id as string, name: data.name as string };
}

/**
 * Read-only medicine list for a linked patient, newest first, with a flag for
 * the official batch-alert reason code so the UI can show the red banner.
 */
export async function getPatientMedicines(
  patientId: string
): Promise<CaregiverMedicine[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("medicines")
    .select("id, name, batch_no, expiry_date, risk_level, risk_reasons, created_at")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row) => {
    const reasons = Array.isArray(row.risk_reasons)
      ? (row.risk_reasons as RiskReason[])
      : [];
    const batchAlert =
      reasons.find(
        (reason) => reason && reason.code === REASON_CODE_ALERT_BATCH_MATCH
      ) ?? null;

    return {
      id: row.id as string,
      name: row.name as string,
      batch_no: (row.batch_no as string | null) ?? null,
      expiry_date: (row.expiry_date as string | null) ?? null,
      risk_level: (row.risk_level as RiskLevel | null) ?? null,
      has_batch_alert: batchAlert !== null,
      alert_message: batchAlert?.message_en ?? null,
    };
  });
}

/**
 * Recent dose history for a linked patient (newest first), joined to the
 * medicine name through schedules. Read-only.
 */
export async function getPatientHistory(
  patientId: string,
  limit = 50
): Promise<CaregiverHistoryRow[]> {
  const supabase = await createClient();

  const { data: doses, error } = await supabase
    .from("dose_logs")
    .select("id, schedule_id, due_at, status, acted_at")
    .eq("patient_id", patientId)
    .order("due_at", { ascending: false })
    .limit(limit);

  if (error || !doses || doses.length === 0) return [];

  const scheduleIds = [...new Set(doses.map((dose) => dose.schedule_id as string))];

  const { data: schedules } = await supabase
    .from("schedules")
    .select("id, medicine_id")
    .in("id", scheduleIds);

  const medicineIds = [
    ...new Set(
      (schedules ?? [])
        .map((schedule) => schedule.medicine_id as string)
        .filter(Boolean)
    ),
  ];

  const medicineName = new Map<string, string>();
  if (medicineIds.length > 0) {
    const { data: medicines } = await supabase
      .from("medicines")
      .select("id, name")
      .in("id", medicineIds);
    for (const medicine of medicines ?? []) {
      medicineName.set(medicine.id as string, medicine.name as string);
    }
  }

  const scheduleMedicine = new Map(
    (schedules ?? []).map((schedule) => [
      schedule.id as string,
      schedule.medicine_id as string,
    ])
  );

  return doses.map((dose) => {
    const medicineId = scheduleMedicine.get(dose.schedule_id as string) ?? "";
    return {
      id: dose.id as string,
      due_at: dose.due_at as string,
      status: dose.status as DoseStatus,
      acted_at: (dose.acted_at as string | null) ?? null,
      medicine_name: medicineName.get(medicineId) ?? "Medicine",
    };
  });
}

/**
 * Everything the dashboard renders, for every linked patient. Each patient's
 * queries run in parallel; the whole list is awaited server-side so the first
 * paint is complete (realtime then keeps it fresh on the client).
 */
export async function getCaregiverDashboard(): Promise<CaregiverPatientSummary[]> {
  const patients = await listLinkedPatients();

  return Promise.all(
    patients.map(async (patient) => {
      const [doses, adherence] = await Promise.all([
        getTodayTimeline(patient.id),
        getWeeklyAdherence(patient.id),
      ]);
      return { patient, doses, adherence };
    })
  );
}
