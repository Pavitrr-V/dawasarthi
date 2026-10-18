"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  JOIN_ATTEMPT_LIMIT,
  JOIN_ATTEMPT_WINDOW_MS,
  firstName,
  isInviteExpired,
  isValidInviteCode,
  normalizeInviteCode,
  rateLimitMinutesLeft,
} from "@/lib/caregiver";

export type ClaimState =
  | { ok: true; patientFirstName: string }
  | { error: string }
  | undefined;

const ClaimSchema = z.object({
  code: z.string().trim().min(1, { error: "Enter the invite code." }).max(32),
});

type LinkRow = {
  id: string;
  status: string;
  consent_given: boolean;
  caregiver_user_id: string | null;
  created_at: string;
  invite_code: string;
  patient_id: string;
};

/**
 * Testing escape hatch for the failed-join rate limit. Set
 * JOIN_RATE_LIMIT_DISABLED=true to skip it locally. This MUST stay unset
 * (off) in production: it disables brute-force protection on invite codes.
 * Only the literal string "true" disables it.
 */
function rateLimitDisabled(): boolean {
  return process.env.JOIN_RATE_LIMIT_DISABLED === "true";
}

/** Persist one failed join attempt. Best-effort: a write error never blocks. */
async function recordFailedAttempt(
  admin: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<void> {
  const { error } = await admin
    .from("caregiver_join_attempts")
    .insert({ user_id: userId });
  if (error) {
    console.error("[claimInvite] could not record attempt", {
      message: error.message,
      code: error.code,
    });
  }
}

type RateLimitResult =
  | { limited: false }
  | { limited: true; minutesLeft: number }
  | { error: true };

/**
 * Count this user's failed attempts in the rolling window. The key is the
 * caller's user id (never an IP), so shared networks do not affect each
 * other. Only real failures are recorded (see recordFailedAttempt calls).
 */
async function checkRateLimit(
  admin: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<RateLimitResult> {
  if (rateLimitDisabled()) return { limited: false };

  const since = new Date(Date.now() - JOIN_ATTEMPT_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("caregiver_join_attempts")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[claimInvite] rate limit lookup failed", {
      message: error.message,
      code: error.code,
    });
    return { error: true };
  }

  const rows = (data ?? []) as { created_at: string }[];
  if (rows.length < JOIN_ATTEMPT_LIMIT) return { limited: false };

  return { limited: true, minutesLeft: rateLimitMinutesLeft(rows[0].created_at) };
}

function tooManyMessage(minutesLeft: number): string {
  if (minutesLeft <= 0) {
    return "Too many attempts. Please try again shortly.";
  }
  const unit = minutesLeft === 1 ? "minute" : "minutes";
  return `Too many attempts. Please try again in about ${minutesLeft} ${unit}.`;
}

/**
 * Claim a caregiver invite.
 *
 * Runs with the service-role client: the caregiver cannot read the invite
 * through RLS yet, and Postgres skips caregiver_links_protect for a
 * service-role request (auth.uid() is null), which lets this set
 * caregiver_user_id while leaving status='pending'. The patient still has
 * to approve before any data is shared.
 *
 * Validation: the code must exist, be unclaimed, unexpired, belong to a
 * different account, and the caller must be a caregiver. Only real failed
 * attempts (not found, expired, already used) count toward the limit of
 * JOIN_ATTEMPT_LIMIT per hour per user; successes and internal (5xx)
 * errors are never counted.
 */
export async function claimCaregiverInvite(
  _state: ClaimState,
  formData: FormData
): Promise<ClaimState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Please sign in again." };
  if (user.role !== "caregiver") {
    return { error: "Only a caregiver account can link to a patient." };
  }

  const parsed = ClaimSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter the invite code." };
  }

  const admin = createAdminClient();

  const limit = await checkRateLimit(admin, user.id);
  if ("error" in limit) {
    return { error: "Something went wrong. Please try again." };
  }
  if (limit.limited) {
    return { error: tooManyMessage(limit.minutesLeft) };
  }

  const code = normalizeInviteCode(parsed.data.code);
  if (!isValidInviteCode(code)) {
    await recordFailedAttempt(admin, user.id);
    return { error: "That invite code is not valid." };
  }

  const { data: link, error: linkError } = await admin
    .from("caregiver_links")
    .select(
      "id, status, consent_given, caregiver_user_id, created_at, invite_code, patient_id"
    )
    .eq("invite_code", code)
    .maybeSingle<LinkRow>();

  if (linkError) {
    console.error("[claimInvite] invite lookup failed", {
      message: linkError.message,
      code: linkError.code,
    });
    return { error: "Something went wrong. Please try again." };
  }
  if (!link) {
    await recordFailedAttempt(admin, user.id);
    return { error: "We could not find that invite code." };
  }

  const { data: patient, error: patientError } = await admin
    .from("patients")
    .select("id, name, owner_user_id")
    .eq("id", link.patient_id)
    .maybeSingle<{ id: string; name: string; owner_user_id: string }>();

  if (patientError) {
    console.error("[claimInvite] patient lookup failed", {
      message: patientError.message,
      code: patientError.code,
    });
    return { error: "Something went wrong. Please try again." };
  }
  if (!patient) {
    // A link with no patient is a data-integrity problem, not a bad attempt.
    console.error("[claimInvite] invite references a missing patient", {
      linkId: link.id,
    });
    return { error: "Something went wrong. Please try again." };
  }

  // Linking to your own account is a user error, not a guessing attempt.
  if (patient.owner_user_id === user.id) {
    return { error: "You cannot link to your own account." };
  }

  // Already claimed by someone else.
  if (link.caregiver_user_id && link.caregiver_user_id !== user.id) {
    await recordFailedAttempt(admin, user.id);
    return { error: "This invite has already been used." };
  }
  // Already claimed by this same caregiver: safe and idempotent, not a failure.
  if (link.caregiver_user_id === user.id) {
    return { ok: true, patientFirstName: firstName(patient.name) };
  }
  if (link.status !== "pending") {
    await recordFailedAttempt(admin, user.id);
    return { error: "This invite is no longer valid." };
  }
  if (isInviteExpired(link.created_at)) {
    await recordFailedAttempt(admin, user.id);
    return { error: "This invite has expired. Ask for a new one." };
  }

  const { data: claimed, error: updateError } = await admin
    .from("caregiver_links")
    .update({ caregiver_user_id: user.id })
    .eq("id", link.id)
    .eq("status", "pending")
    .is("caregiver_user_id", null)
    .select("id");

  if (updateError) {
    console.error("[claimInvite] claim failed", {
      message: updateError.message,
      code: updateError.code,
    });
    return { error: "Could not send the request. Please try again." };
  }
  if (!claimed || claimed.length === 0) {
    // Lost a race against another claimer: a real failed attempt.
    await recordFailedAttempt(admin, user.id);
    return { error: "This invite has already been used." };
  }

  revalidatePath("/join");
  revalidatePath("/caregiver");
  revalidatePath("/caregiver/patients");
  return { ok: true, patientFirstName: firstName(patient.name) };
}
