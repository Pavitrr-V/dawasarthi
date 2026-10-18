"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getOwnedPatient } from "@/lib/patients";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateDoses,
  istToday,
  normalizeTimes,
} from "@/lib/schedule";
import { parsePattern, slotsToTimes } from "@/lib/prescription";
import { recomputeMedicineRisk } from "@/lib/risk-recompute";
import {
  AuthError,
  BudgetExceeded,
  ConfigError,
  RateLimitError,
  UpstreamError,
  countTodayAgentJobs,
  startAgentRun,
  tinyfishDailyCap,
  tinyfishEnabled,
} from "@/lib/tinyfish";
import {
  countRecentVerifyStarts,
  hourlyLimitReached,
  verifyGoal,
  verifySearchUrl,
  verifySources,
} from "@/lib/verify";

/** Hard cap on TinyFish verify jobs started for one prescription. */
const MAX_VERIFY_PER_PRESCRIPTION = 4;
/** A medicine with no strength still gets one composition-less entry. */

const rowSchema = z.object({
  name: z.string().trim().min(1, { error: "Every medicine needs a name." }).max(160),
  strength: z.string().trim().max(60),
  form: z.string().trim().max(40),
  pattern: z.string().trim().regex(/^\d-\d-\d$/, { error: "Pick a dose pattern." }),
  timing: z.enum(["before_food", "after_food", "with_food", "any"]),
  duration_days: z
    .string()
    .regex(/^\d{1,3}$/, { error: "Duration must be a number of days." }),
  instructions: z.string().trim().max(500),
  tablet_count: z
    .string()
    .regex(/^\d{0,6}$/, { error: "Tablet count must be a number." }),
  raw_text: z.string().max(500),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
});

const inputSchema = z.object({
  patientId: z.string().uuid(),
  rows: z.array(rowSchema).min(1, { error: "Add at least one medicine." }).max(20),
  imagePaths: z.array(z.string().min(1).max(400)).max(2),
});

export type SavePrescriptionRow = z.infer<typeof rowSchema>;
export type SavePrescriptionInput = z.infer<typeof inputSchema>;

export type SavePrescriptionResult =
  | {
      ok: true;
      medicineIds: string[];
      /** Names that had no medicine_catalog match (flagged amber in the UI). */
      catalogUnmatched: string[];
      /** How many TinyFish verify jobs were started (0 when capped/disabled). */
      verifyStarted: number;
    }
  | { ok: false; error: string };

/** Fuzzy-matches a name against medicine_catalog; null when there is no match. */
async function catalogMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  name: string
): Promise<string | null> {
  const term = name.trim();
  if (term.length < 3) return null;
  try {
    const { data } = await supabase.rpc("search_medicine_catalog", {
      p_query: term,
      p_threshold: 0.5,
      p_limit: 1,
    });
    if (!Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as { name?: unknown };
    return typeof row?.name === "string" && row.name.trim().length > 0
      ? row.name.trim()
      : null;
  } catch {
    return null;
  }
}

type VerifyTarget = {
  id: string;
  name: string;
  composition: string[] | null;
  manufacturer: string | null;
};

/**
 * Starts one TinyFish verify job per matched medicine (capped at 4 and by the
 * daily budget). Runs in the background of the save — the result is not waited
 * on, so it can never block or fail the prescription save.
 */
async function startVerifyJobs(
  admin: ReturnType<typeof createAdminClient>,
  targets: VerifyTarget[],
  userId: string
): Promise<number> {
  if (!tinyfishEnabled()) return 0;

  const sources = verifySources();
  if (sources.length === 0) return 0;

  const budget = tinyfishDailyCap();
  let startedToday = 0;
  try {
    startedToday = await countTodayAgentJobs();
  } catch {
    startedToday = 0;
  }
  if (startedToday >= budget) return 0;

  let recent = 0;
  try {
    recent = await countRecentVerifyStarts(admin, userId);
  } catch {
    recent = 0;
  }
  if (hourlyLimitReached(recent)) return 0;

  const capped = targets.slice(0, MAX_VERIFY_PER_PRESCRIPTION);
  let started = 0;

  for (const target of capped) {
    if (startedToday + started >= budget) break;

    const source = sources[0];
    const searchUrl = verifySearchUrl(source.url, target.name);
    const goal = verifyGoal({
      name: target.name,
      composition: target.composition,
      manufacturer: target.manufacturer,
    });

    let runId: string;
    try {
      runId = (await startAgentRun({ url: searchUrl, goal })).runId;
    } catch (error) {
      if (
        error instanceof BudgetExceeded ||
        error instanceof ConfigError ||
        error instanceof AuthError ||
        error instanceof RateLimitError ||
        error instanceof UpstreamError
      ) {
        if (error instanceof BudgetExceeded) break;
        continue;
      }
      continue;
    }

    const jobId = crypto.randomUUID();
    const { error: jobError } = await admin.from("tinyfish_jobs").insert({
      id: jobId,
      kind: "verify",
      medicine_id: target.id,
      user_id: userId,
      run_id: runId,
      status: "running",
    });
    if (jobError) continue;

    await admin.from("online_verifications").insert({
      medicine_id: target.id,
      source_site: source.site,
      source_url: searchUrl,
      status: "pending",
      raw: { job_id: jobId, source: "verify", site: source.site },
    });

    started += 1;
  }

  return started;
}

/**
 * Saves a confirmed prescription: for each medicine line it finds/creates a
 * medicines row (fuzzy-matched against medicine_catalog), creates a schedule
 * and the first week of dose_logs, records stock when a tablet count is given,
 * runs the DB-only alert match for every medicine, and queues one background
 * batch of TinyFish verify jobs for the catalog-matched ones.
 */
export async function savePrescription(
  input: SavePrescriptionInput
): Promise<SavePrescriptionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return { ok: false, error: "Only a patient account can add medicines." };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the medicines.",
    };
  }
  const { rows, imagePaths } = parsed.data;

  // Reject any image path that is not in this user's own storage folder.
  for (const path of imagePaths) {
    if (!path.startsWith(`${user.id}/`)) {
      return { ok: false, error: "That photo does not belong to your account." };
    }
  }

  const patient = await getOwnedPatient(parsed.data.patientId);
  if (!patient) {
    return { ok: false, error: "Add a patient profile before saving." };
  }

  const mealTimes = {
    breakfast: patient.breakfast_time,
    lunch: patient.lunch_time,
    dinner: patient.dinner_time,
  };

  const supabase = await createClient();
  const startDate = istToday();
  const medicineIds: string[] = [];
  const catalogUnmatched: string[] = [];
  const verifyTargets: VerifyTarget[] = [];

  for (const row of rows) {
    const matchedName = await catalogMatch(supabase, row.name);
    if (!matchedName) catalogUnmatched.push(row.name);

    const composition = row.strength ? [row.strength] : [];

    const { data: inserted, error } = await supabase
      .from("medicines")
      .insert({
        patient_id: patient.id,
        name: row.name,
        composition,
        risk_level: "amber",
        risk_reasons: [],
        info: {
          scan_mode: "prescription",
          source: "scan",
          confidence: { name: row.confidence },
          raw_text: row.raw_text,
          form: row.form || null,
          instructions: row.instructions || null,
          timing: row.timing,
          pattern: row.pattern,
          catalog_match: matchedName,
          verify_status: "pending",
        },
      })
      .select("id")
      .single();

    if (error || !inserted) {
      console.error("[savePrescription] insert failed", {
        message: error?.message,
        code: error?.code,
      });
      return { ok: false, error: "Could not save a medicine. Please try again." };
    }
    const medicineId = inserted.id as string;
    medicineIds.push(medicineId);

    if (matchedName) {
      verifyTargets.push({
        id: medicineId,
        name: row.name,
        composition,
        manufacturer: null,
      });
    }

    // Deterministic verdict + DB-only alert match (no TinyFish) for this row.
    try {
      await recomputeMedicineRisk(medicineId);
    } catch (recomputeError) {
      console.error("[savePrescription] risk recompute failed", {
        message:
          recomputeError instanceof Error ? recomputeError.message : recomputeError,
      });
    }

    // Schedule + first week of dose_logs.
    const slots = parsePattern(row.pattern);
    const times = normalizeTimes(
      slotsToTimes(slots, mealTimes, row.timing)
    );
    const durationDays = Number(row.duration_days);
    const scheduleId = crypto.randomUUID();

    const { error: scheduleError } = await supabase.from("schedules").insert({
      id: scheduleId,
      medicine_id: medicineId,
      patient_id: patient.id,
      times: times.map((time) => `${time}:00`),
      days_pattern: "daily",
      weekdays: [],
      meal_link: null,
      start_date: startDate,
      duration_days: Number.isFinite(durationDays) ? durationDays : null,
      active: true,
    });

    if (scheduleError) {
      console.error("[savePrescription] schedule failed", {
        message: scheduleError.message,
      });
      return { ok: false, error: "Could not create a reminder. Please try again." };
    }

    const doses = generateDoses(
      {
        id: scheduleId,
        patient_id: patient.id,
        times,
        days_pattern: "daily",
        weekdays: [],
        start_date: startDate,
        duration_days: Number.isFinite(durationDays) ? durationDays : null,
      },
      7
    );

    if (doses.length > 0) {
      const { error: doseError } = await supabase.from("dose_logs").upsert(doses, {
        onConflict: "schedule_id,due_at",
        ignoreDuplicates: true,
      });
      if (doseError) {
        await supabase.from("schedules").delete().eq("id", scheduleId);
        return { ok: false, error: "Could not create reminders. Please try again." };
      }
    }

    // Stock: only when the user entered a tablet count.
    const tablets = Number(row.tablet_count);
    if (row.tablet_count !== "" && Number.isFinite(tablets) && tablets >= 0) {
      await supabase
        .from("inventory")
        .upsert(
          { medicine_id: medicineId, quantity_left: tablets, unit: "tablets" },
          { onConflict: "medicine_id" }
        );
    }
  }

  // ONE background batch: TinyFish verify jobs for the catalog-matched
  // medicines only, capped at 4 and by the daily budget.
  let verifyStarted = 0;
  try {
    const admin = createAdminClient();
    verifyStarted = await startVerifyJobs(admin, verifyTargets, user.id);
  } catch (verifyError) {
    console.error("[savePrescription] verify batch failed", {
      message:
        verifyError instanceof Error ? verifyError.message : verifyError,
    });
  }

  revalidatePath("/", "layout");
  revalidatePath("/cabinet");
  revalidatePath("/home");

  return { ok: true, medicineIds, catalogUnmatched, verifyStarted };
}
