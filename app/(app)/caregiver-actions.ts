"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { generateInviteCode, normalizeCaregiverPhone } from "@/lib/caregiver";

export type InviteState =
  | { code: string; patientId: string; caregiverName: string | null }
  | { error: string }
  | undefined;

const InviteSchema = z.object({
  patient_id: z.string().uuid({ error: "Choose a patient profile." }),
  caregiver_name: z
    .string()
    .trim()
    .max(80)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().optional(),
});

const MAX_CODE_ATTEMPTS = 5;

/**
 * Create a caregiver invitation for a patient owned by the caller.
 *
 * Writes through the caller's own client so RLS
 * (caregiver_links_insert_owner) and the caregiver_links_protect trigger
 * both require patient ownership. The invite code is generated here and
 * returned to the caller to render as text + QR; we deliberately do not
 * `.select()` the row back.
 */
export async function createCaregiverInvite(
  _state: InviteState,
  formData: FormData
): Promise<InviteState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Please sign in again." };
  if (user.role !== "patient") {
    return { error: "Only a patient account can invite a caregiver." };
  }

  const parsed = InviteSchema.safeParse({
    patient_id: formData.get("patient_id"),
    caregiver_name: formData.get("caregiver_name"),
    phone: formData.get("phone"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const rawPhone = parsed.data.phone ?? "";
  const phone = normalizeCaregiverPhone(rawPhone);
  if (rawPhone.trim().length > 0 && phone === null) {
    return { error: "Enter a valid mobile number (e.g. 98765 43210)." };
  }

  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select("id")
    .eq("id", parsed.data.patient_id)
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!patient) return { error: "That patient profile was not found." };

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateInviteCode();
    const { error } = await supabase.from("caregiver_links").insert({
      patient_id: patient.id,
      invite_code: code,
      caregiver_phone: phone,
    });

    if (!error) {
      revalidatePath("/profile");
      return {
        code,
        patientId: patient.id,
        caregiverName: parsed.data.caregiver_name ?? null,
      };
    }

    // 23505 = unique_violation. Retry only when the code itself collided.
    if (error.code !== "23505") {
      console.error("[createCaregiverInvite] insert failed", {
        message: error.message,
        code: error.code,
      });
      return { error: "Could not create the invitation. Please try again." };
    }
  }

  return { error: "Could not generate a unique code. Please try again." };
}

type LinkAction = "approve" | "decline" | "revoke" | "cancel";

/**
 * Approve, decline, revoke or cancel a caregiver link. All four are
 * ownership-checked through the caller's own client (RLS + the
 * caregiver_links_protect trigger): the patient owner is the only account
 * allowed to change consent or status.
 */
async function applyLinkAction(formData: FormData, action: LinkAction) {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") return;

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const supabase = await createClient();

  // Resolve the link and confirm the caller owns its patient.
  const { data: link } = await supabase
    .from("caregiver_links")
    .select("id, patient_id, caregiver_user_id")
    .eq("id", id)
    .maybeSingle();
  if (!link) return;

  const { data: patient } = await supabase
    .from("patients")
    .select("id")
    .eq("id", link.patient_id)
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!patient) return;

  if (action === "cancel") {
    // Only an unclaimed invite may be removed outright.
    if (link.caregiver_user_id !== null) return;
    await supabase.from("caregiver_links").delete().eq("id", link.id);
    revalidatePath("/profile");
    return;
  }

  const patch =
    action === "approve"
      ? { status: "active" as const, consent_given: true }
      : { status: "revoked" as const, consent_given: false };

  const { error } = await supabase
    .from("caregiver_links")
    .update(patch)
    .eq("id", link.id);

  if (error) {
    console.error("[caregiverLink] update failed", {
      message: error.message,
      code: error.code,
      action,
    });
  }

  revalidatePath("/profile");
}

export async function approveCaregiver(formData: FormData): Promise<void> {
  await applyLinkAction(formData, "approve");
}

export async function declineCaregiver(formData: FormData): Promise<void> {
  await applyLinkAction(formData, "decline");
}

export async function revokeCaregiver(formData: FormData): Promise<void> {
  await applyLinkAction(formData, "revoke");
}

export async function cancelCaregiverInvite(formData: FormData): Promise<void> {
  await applyLinkAction(formData, "cancel");
}
