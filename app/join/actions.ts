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
 * Claim a caregiver invite.
 *
 * Runs with the service-role client: the caregiver cannot read the invite
 * through RLS yet, and Postgres skips caregiver_links_protect for a
 * service-role request (auth.uid() is null), which lets this set
 * caregiver_user_id while leaving status='pending'. The patient still has
 * to approve before any data is shared.
 *
 * Validation: the code must exist, be unclaimed, unexpired, belong to a
 * different account, and the caller must be a caregiver. Attempts are
 * rate-limited to 5 per hour per user.
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

  const code = normalizeInviteCode(parsed.data.code);
  if (!isValidInviteCode(code)) {
    return { error: "That invite code is not valid." };
  }

  const admin = createAdminClient();

  const since = new Date(Date.now() - JOIN_ATTEMPT_WINDOW_MS).toISOString();
  const { count, error: countError } = await admin
    .from("caregiver_join_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", since);

  if (countError) {
    console.error("[claimInvite] rate limit lookup failed", {
      message: countError.message,
      code: countError.code,
    });
    return { error: "Something went wrong. Please try again." };
  }
  if ((count ?? 0) >= JOIN_ATTEMPT_LIMIT) {
    return { error: "Too many attempts. Please wait an hour and try again." };
  }

  // Record the attempt before doing the work, so failures still count.
  await admin.from("caregiver_join_attempts").insert({ user_id: user.id });

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
    return { error: "We could not find that invite code." };
  }

  const { data: patient } = await admin
    .from("patients")
    .select("id, name, owner_user_id")
    .eq("id", link.patient_id)
    .maybeSingle<{ id: string; name: string; owner_user_id: string }>();

  if (!patient) return { error: "This invite is no longer valid." };

  if (patient.owner_user_id === user.id) {
    return { error: "You cannot link to your own account." };
  }

  // Already claimed by someone else, or no longer pending.
  if (link.caregiver_user_id && link.caregiver_user_id !== user.id) {
    return { error: "This invite has already been used." };
  }
  if (link.caregiver_user_id === user.id) {
    // Re-submitting the same code is safe and idempotent.
    return { ok: true, patientFirstName: firstName(patient.name) };
  }
  if (link.status !== "pending") {
    return { error: "This invite is no longer valid." };
  }
  if (isInviteExpired(link.created_at)) {
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
    return { error: "This invite has already been used." };
  }

  revalidatePath("/join");
  revalidatePath("/caregiver");
  revalidatePath("/caregiver/patients");
  return { ok: true, patientFirstName: firstName(patient.name) };
}
