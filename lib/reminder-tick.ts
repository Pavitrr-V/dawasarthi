import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPushToUser, type PushNotificationPayload } from "@/lib/push";
import { doseActionUrl } from "@/lib/push-token";
import { sendSms, sendWhatsApp, twilioConfigured } from "@/lib/twilio";
import {
  generateDoses,
  istClockLabel,
  istHour,
  istToday,
  weekdayOf,
  type GeneratedDose,
  type ScheduleForDoses,
} from "@/lib/schedule";
import { finishVerifyJob } from "@/lib/verify";
import { finishAlertSyncJob, startAlertSyncJob } from "@/lib/alert-sync";
import { finishPriceJob } from "@/lib/price";
import { BudgetExceeded, getAgentRun } from "@/lib/tinyfish";

/**
 * The minute-by-minute reminder worker behind GET /api/cron/tick.
 *
 * One run, in order:
 *   1. First reminder   - pending dose due, reminder_count 0 -> 1  (push).
 *   2. Repeat reminder  - pending, reminder_count 1, past the patient's
 *                         repeat delay -> 2                      (push).
 *   3. Caregiver escalation - pending, past the patient's caregiver delay:
 *                         mark the dose missed once, then push every active,
 *                         consented caregiver; fall back to Twilio SMS +
 *                         WhatsApp when push cannot reach them.
 *   4. Daily top-up     - generate the next 7 days of doses for every active
 *                         schedule (once a day, idempotent upsert).
 *   5. Weekly alert sync - start the NSQ alert_sync job on Monday >= 06:00 IST
 *                         when none has run in the last 6 days.
 *   6. TinyFish polling - claim and finish queued/running agent jobs. Runs
 *                         last and can never throw into the steps above.
 *
 * Idempotency: every claim is a single atomic `UPDATE ... WHERE ... RETURNING`
 * inside a SECURITY DEFINER function (see migration 012), so two overlapping
 * ticks can never double-send or double-process. A tick that loses the race
 * simply sees zero rows.
 *
 * Server-only: imports the service-role client, web-push and Twilio.
 */

/** How many reminders / escalations one tick will send. */
export const REMINDER_BATCH = 20;
/** How many agent jobs one tick will poll. */
export const JOB_BATCH = 10;
/** Days of doses the daily top-up keeps materialised. */
export const TOP_UP_HORIZON_DAYS = 7;
/** A queued/running agent job older than this is treated as failed. */
export const JOB_STALE_MS = 5 * 60 * 1000;
/** The weekly alert sync will not restart within this window. */
const ALERT_SYNC_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;

type Admin = SupabaseClient;

type ReminderRow = {
  dose_id: string;
  patient_id: string;
  owner_user_id: string;
  patient_name: string;
  medicine_name: string;
  due_at: string;
};

type TinyfishJob = {
  id: string;
  kind: "verify" | "price" | "alert_sync";
  medicine_id: string | null;
  user_id: string | null;
  run_id: string | null;
  status: string;
  attempts: number;
  created_at: string;
};

type CaregiverLink = {
  patient_id: string;
  caregiver_user_id: string | null;
  caregiver_phone: string | null;
};

export type TickStep = {
  name: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

export type TickResult = {
  ok: boolean;
  ranAt: string;
  steps: TickStep[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

/** Runs `fn`, and on failure runs it once more (the "1 retry" rule). */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type NotificationEntry = {
  channel: "push" | "sms" | "whatsapp";
  status: "sent" | "failed" | "skipped";
  user_id?: string | null;
  patient_id?: string | null;
  dose_id?: string | null;
  to_phone?: string | null;
  error?: string | null;
  attempts?: number;
};

/** Best-effort: a logging failure must never break a send. */
async function logNotification(admin: Admin, entry: NotificationEntry): Promise<void> {
  try {
    await admin.from("notification_log").insert({
      user_id: entry.user_id ?? null,
      patient_id: entry.patient_id ?? null,
      dose_id: entry.dose_id ?? null,
      channel: entry.channel,
      status: entry.status,
      to_phone: entry.to_phone ?? null,
      error: entry.error ? entry.error.slice(0, 500) : null,
      attempts: entry.attempts ?? 1,
    });
  } catch (error) {
    console.warn("[tick] notification_log insert failed:", messageOf(error));
  }
}

// ---------------------------------------------------------------------------
// Push payloads
// ---------------------------------------------------------------------------

function dosePayload(
  row: ReminderRow,
  content: { title: string; body: string }
): PushNotificationPayload {
  const payload: PushNotificationPayload = {
    title: content.title,
    body: content.body,
    url: "/home",
    tag: `dose-${row.dose_id}`,
  };

  // The action buttons need a signing secret; without one, send a plain alert.
  try {
    payload.doseId = row.dose_id;
    payload.actionUrl = doseActionUrl(row.dose_id, row.owner_user_id);
    payload.actions = true;
  } catch {
    payload.actions = false;
  }

  return payload;
}

function caregiverPayload(row: ReminderRow, body: string): PushNotificationPayload {
  return {
    title: "Caregiver alert",
    body,
    url: "/caregiver",
    tag: `missed-${row.dose_id}`,
  };
}

type PushOutcome = {
  reached: boolean;
  status: "sent" | "failed" | "skipped";
  error: string | null;
  attempts: number;
};

async function deliverPush(
  admin: Admin,
  userId: string,
  payload: PushNotificationPayload
): Promise<PushOutcome> {
  try {
    const result = await withOneRetry(() => sendPushToUser(userId, payload, admin));
    if (result.sent > 0) {
      return { reached: true, status: "sent", error: null, attempts: 1 };
    }
    if (result.skipped) {
      return { reached: false, status: "skipped", error: result.skipped, attempts: 1 };
    }
    return { reached: false, status: "failed", error: "No device accepted the push.", attempts: 2 };
  } catch (error) {
    return { reached: false, status: "failed", error: messageOf(error), attempts: 2 };
  }
}

// ---------------------------------------------------------------------------
// Step 1 + 2: patient reminders
// ---------------------------------------------------------------------------

function caregiverMessage(row: ReminderRow): string {
  const time = istClockLabel(row.due_at).toUpperCase();
  return `${row.patient_name} ne ${time} ki ${row.medicine_name} abhi tak nahi li.`;
}

async function sendFirstReminders(admin: Admin): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("claim_first_reminders", {
    p_limit: REMINDER_BATCH,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ReminderRow[];
  const counts = { sent: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const outcome = await deliverPush(
      admin,
      row.owner_user_id,
      dosePayload(row, {
        title: "Time for your medicine",
        body: `${row.medicine_name} is due now.`,
      })
    );
    counts[outcome.status] += 1;
    await logNotification(admin, {
      channel: "push",
      status: outcome.status,
      user_id: row.owner_user_id,
      patient_id: row.patient_id,
      dose_id: row.dose_id,
      error: outcome.error,
      attempts: outcome.attempts,
    });
  }

  return { claimed: rows.length, ...counts };
}

async function sendRepeatReminders(admin: Admin): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("claim_repeat_reminders", {
    p_limit: REMINDER_BATCH,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ReminderRow[];
  const counts = { sent: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const outcome = await deliverPush(
      admin,
      row.owner_user_id,
      dosePayload(row, {
        title: "Reminder: dose still pending",
        body: `${row.medicine_name} is still waiting to be taken.`,
      })
    );
    counts[outcome.status] += 1;
    await logNotification(admin, {
      channel: "push",
      status: outcome.status,
      user_id: row.owner_user_id,
      patient_id: row.patient_id,
      dose_id: row.dose_id,
      error: outcome.error,
      attempts: outcome.attempts,
    });
  }

  return { claimed: rows.length, ...counts };
}

// ---------------------------------------------------------------------------
// Step 3: caregiver escalation
// ---------------------------------------------------------------------------

async function sendCaregiverEscalations(admin: Admin): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("claim_caregiver_escalations", {
    p_limit: REMINDER_BATCH,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ReminderRow[];
  if (rows.length === 0) return { claimed: 0, caregivers: 0, sms: 0 };

  const patientIds = [...new Set(rows.map((row) => row.patient_id))];

  // Only links the patient has explicitly consented to, and that are active.
  const { data: linkData, error: linkError } = await admin
    .from("caregiver_links")
    .select("patient_id, caregiver_user_id, caregiver_phone")
    .in("patient_id", patientIds)
    .eq("status", "active")
    .eq("consent_given", true);
  if (linkError) throw new Error(linkError.message);

  const links = (linkData ?? []) as CaregiverLink[];

  // Fallback phone numbers live on the caregiver's user row.
  const caregiverIds = [
    ...new Set(links.map((link) => link.caregiver_user_id).filter((id): id is string => !!id)),
  ];
  const phoneByUser = new Map<string, string | null>();
  if (caregiverIds.length > 0) {
    const { data: users } = await admin
      .from("users")
      .select("id, phone")
      .in("id", caregiverIds);
    for (const user of (users ?? []) as { id: string; phone: string | null }[]) {
      phoneByUser.set(user.id, user.phone ?? null);
    }
  }

  let smsSent = 0;
  let waSent = 0;

  for (const row of rows) {
    const message = caregiverMessage(row);

    for (const link of links.filter((l) => l.patient_id === row.patient_id)) {
      const caregiverUserId = link.caregiver_user_id ?? null;
      const phone =
        link.caregiver_phone ??
        (caregiverUserId ? phoneByUser.get(caregiverUserId) ?? null : null);

      // Push first.
      let reached = false;
      if (caregiverUserId) {
        const outcome = await deliverPush(
          admin,
          caregiverUserId,
          caregiverPayload(row, message)
        );
        reached = outcome.reached;
        await logNotification(admin, {
          channel: "push",
          status: outcome.status,
          user_id: caregiverUserId,
          patient_id: row.patient_id,
          dose_id: row.dose_id,
          error: outcome.error,
          attempts: outcome.attempts,
        });
      }

      if (reached) continue;

      // Push did not reach anyone: fall back to SMS + WhatsApp.
      if (!phone) {
        await logNotification(admin, {
          channel: "sms",
          status: "skipped",
          user_id: caregiverUserId,
          patient_id: row.patient_id,
          dose_id: row.dose_id,
          error: "No phone number on file.",
        });
        await logNotification(admin, {
          channel: "whatsapp",
          status: "skipped",
          user_id: caregiverUserId,
          patient_id: row.patient_id,
          dose_id: row.dose_id,
          error: "No phone number on file.",
        });
        continue;
      }

      if (!twilioConfigured()) {
        await logNotification(admin, {
          channel: "sms",
          status: "skipped",
          user_id: caregiverUserId,
          patient_id: row.patient_id,
          dose_id: row.dose_id,
          to_phone: phone,
          error: "Twilio is not configured.",
        });
        await logNotification(admin, {
          channel: "whatsapp",
          status: "skipped",
          user_id: caregiverUserId,
          patient_id: row.patient_id,
          dose_id: row.dose_id,
          to_phone: phone,
          error: "Twilio is not configured.",
        });
        continue;
      }

      if (await deliverSms(admin, row, caregiverUserId, phone, message)) smsSent += 1;
      if (await deliverWhatsApp(admin, row, caregiverUserId, phone, message)) waSent += 1;
    }
  }

  return { claimed: rows.length, caregivers: links.length, sms: smsSent, whatsapp: waSent };
}

async function deliverSms(
  admin: Admin,
  row: ReminderRow,
  caregiverUserId: string | null,
  phone: string,
  body: string
): Promise<boolean> {
  try {
    await withOneRetry(() => sendSms(phone, body));
    await logNotification(admin, {
      channel: "sms",
      status: "sent",
      user_id: caregiverUserId,
      patient_id: row.patient_id,
      dose_id: row.dose_id,
      to_phone: phone,
    });
    return true;
  } catch (error) {
    await logNotification(admin, {
      channel: "sms",
      status: "failed",
      user_id: caregiverUserId,
      patient_id: row.patient_id,
      dose_id: row.dose_id,
      to_phone: phone,
      error: messageOf(error),
      attempts: 2,
    });
    return false;
  }
}

async function deliverWhatsApp(
  admin: Admin,
  row: ReminderRow,
  caregiverUserId: string | null,
  phone: string,
  body: string
): Promise<boolean> {
  try {
    await withOneRetry(() => sendWhatsApp(phone, body));
    await logNotification(admin, {
      channel: "whatsapp",
      status: "sent",
      user_id: caregiverUserId,
      patient_id: row.patient_id,
      dose_id: row.dose_id,
      to_phone: phone,
    });
    return true;
  } catch (error) {
    await logNotification(admin, {
      channel: "whatsapp",
      status: "failed",
      user_id: caregiverUserId,
      patient_id: row.patient_id,
      dose_id: row.dose_id,
      to_phone: phone,
      error: messageOf(error),
      attempts: 2,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 4: daily dose top-up
// ---------------------------------------------------------------------------

async function runDoseTopUp(admin: Admin): Promise<Record<string, unknown>> {
  const { data: shouldRun, error } = await admin.rpc("claim_daily_top_up");
  if (error) throw new Error(error.message);
  if (!shouldRun) return { skipped: "already-ran-today" };

  const { data, error: scheduleError } = await admin
    .from("schedules")
    .select("id, patient_id, times, days_pattern, weekdays, start_date, duration_days")
    .eq("active", true);
  if (scheduleError) throw new Error(scheduleError.message);

  const schedules = (data ?? []) as ScheduleForDoses[];
  const now = new Date();

  const rows: GeneratedDose[] = [];
  const seen = new Set<string>();
  for (const schedule of schedules) {
    for (const dose of generateDoses(schedule, TOP_UP_HORIZON_DAYS, now)) {
      const key = `${dose.schedule_id}|${dose.due_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(dose);
    }
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // The (schedule_id, due_at) unique index makes a re-run a no-op.
    const { error: upsertError } = await admin
      .from("dose_logs")
      .upsert(chunk, { onConflict: "schedule_id,due_at", ignoreDuplicates: true });
    if (!upsertError) inserted += chunk.length;
  }

  return { schedules: schedules.length, generated: rows.length, inserted };
}

// ---------------------------------------------------------------------------
// Step 5: weekly alert sync
// ---------------------------------------------------------------------------

async function maybeStartWeeklyAlertSync(admin: Admin): Promise<Record<string, unknown>> {
  const weekday = weekdayOf(istToday());
  const hour = istHour(new Date().toISOString());
  if (weekday !== 1 || hour < 6) return { skipped: "not-monday-morning" };

  const since = new Date(Date.now() - ALERT_SYNC_MIN_GAP_MS).toISOString();
  const { count } = await admin
    .from("tinyfish_jobs")
    .select("id", { count: "exact", head: true })
    .eq("kind", "alert_sync")
    .gte("created_at", since);
  if ((count ?? 0) > 0) return { skipped: "recent-run-exists" };

  try {
    const { jobId } = await startAlertSyncJob();
    return { started: true, job_id: jobId };
  } catch (error) {
    if (error instanceof BudgetExceeded) return { skipped: "budget-exceeded" };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Step 6: TinyFish job polling (runs last, never throws into the others)
// ---------------------------------------------------------------------------

function isJobStale(createdAt: string): boolean {
  const started = new Date(createdAt).getTime();
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > JOB_STALE_MS;
}

/** Hands a completed run to the finisher that knows how to store it. */
async function dispatchFinisher(job: TinyfishJob): Promise<"done" | "failed" | "running"> {
  switch (job.kind) {
    case "verify":
      return finishVerifyJob({
        id: job.id,
        medicine_id: job.medicine_id,
        run_id: job.run_id,
        created_at: job.created_at,
      });
    case "price":
      return finishPriceJob({
        id: job.id,
        medicine_id: job.medicine_id,
        run_id: job.run_id,
        created_at: job.created_at,
      });
    case "alert_sync":
      return finishAlertSyncJob({
        id: job.id,
        run_id: job.run_id,
        created_at: job.created_at,
      });
  }
}

async function markJobFailed(admin: Admin, id: string, error: string): Promise<void> {
  const { error: rpcError } = await admin.rpc("mark_job_failed", {
    p_id: id,
    p_error: error,
  });
  if (rpcError) {
    // Fall back to a guarded update so at least the status moves.
    await admin
      .from("tinyfish_jobs")
      .update({ status: "failed", error: error.slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["queued", "running"])
      .select("id");
  }
}

async function pollTinyfishJobs(admin: Admin): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("claim_tinyfish_jobs", { p_limit: JOB_BATCH });
  if (error) throw new Error(error.message);

  const jobs = (data ?? []) as TinyfishJob[];
  let done = 0;
  let failed = 0;
  let running = 0;

  for (const job of jobs) {
    try {
      if (!job.run_id) {
        await markJobFailed(admin, job.id, "Agent run id is missing.");
        failed += 1;
        continue;
      }

      let run;
      try {
        // Poll once to make the branch decision; the finisher then re-reads the
        // run and performs the kind-specific validation + persistence.
        run = await getAgentRun(job.run_id);
      } catch (error) {
        if (isJobStale(job.created_at)) {
          await markJobFailed(admin, job.id, messageOf(error));
          failed += 1;
        } else {
          running += 1;
        }
        continue;
      }

      if (run.status === "failed") {
        await markJobFailed(admin, job.id, run.error ?? "Agent run failed.");
        failed += 1;
        continue;
      }

      if (run.status === "running") {
        if (isJobStale(job.created_at)) {
          await markJobFailed(
            admin,
            job.id,
            `Agent run did not finish within ${JOB_STALE_MS / 60000} minutes.`
          );
          failed += 1;
        } else {
          running += 1;
        }
        continue;
      }

      // COMPLETED: let the kind-specific finisher validate + persist it.
      const outcome = await dispatchFinisher(job);
      if (outcome === "done") {
        done += 1;
      } else if (outcome === "failed") {
        await admin.rpc("bump_job_attempts", { p_id: job.id });
        failed += 1;
      } else {
        running += 1;
      }
    } catch (error) {
      if (isJobStale(job.created_at)) {
        await markJobFailed(admin, job.id, messageOf(error));
        failed += 1;
      } else {
        running += 1;
      }
    }
  }

  return { claimed: jobs.length, done, failed, running };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs one tick. Every step is isolated: a failure is recorded in `steps` and
 * the remaining steps still run, so one bad integration cannot stall reminders.
 */
export async function runReminderTick(): Promise<TickResult> {
  const admin = createAdminClient();
  const steps: TickStep[] = [];

  const run = async (
    name: string,
    fn: () => Promise<Record<string, unknown>>
  ): Promise<void> => {
    try {
      steps.push({ name, ok: true, data: await fn() });
    } catch (error) {
      steps.push({ name, ok: false, error: messageOf(error) });
    }
  };

  await run("first_reminder", () => sendFirstReminders(admin));
  await run("repeat_reminder", () => sendRepeatReminders(admin));
  await run("caregiver_escalation", () => sendCaregiverEscalations(admin));
  await run("dose_top_up", () => runDoseTopUp(admin));
  await run("weekly_alert_sync", () => maybeStartWeeklyAlertSync(admin));
  await run("tinyfish_jobs", () => pollTinyfishJobs(admin));

  return {
    ok: steps.every((step) => step.ok),
    ranAt: new Date().toISOString(),
    steps,
  };
}
