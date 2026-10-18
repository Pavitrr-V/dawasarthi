import { createAdminClient } from "@/lib/supabase/admin";
import {
  firstName,
  maskPhone,
  type CaregiverLinkStatus,
  type CaregiverLinkView,
  type CaregiverPatientView,
} from "@/lib/caregiver";

/**
 * Server-only caregiver-link reads.
 *
 * These use the service-role client because a caregiver cannot see an
 * invite before claiming it, and a patient cannot read another user's
 * `users` row. Every function here returns the *minimum* data a screen
 * needs (a first name, a masked phone) and must only be called from a
 * server component/route that has already authenticated the caller.
 */

export type InvitePreview = {
  id: string;
  status: CaregiverLinkStatus;
  consentGiven: boolean;
  caregiverUserId: string | null;
  createdAt: string;
  patientId: string;
  patientOwnerId: string;
  patientFirstName: string;
};

type LinkRow = {
  id: string;
  status: CaregiverLinkStatus;
  consent_given: boolean;
  created_at: string;
  invite_code: string;
  caregiver_user_id: string | null;
  caregiver_phone: string | null;
  patient_id: string;
};

const LINK_COLUMNS =
  "id, status, consent_given, created_at, invite_code, caregiver_user_id, caregiver_phone, patient_id";

/** Look up an invite by its code for the /join consent screen. */
export async function loadInvitePreview(
  code: string
): Promise<InvitePreview | null> {
  const admin = createAdminClient();

  const { data: link, error } = await admin
    .from("caregiver_links")
    .select(LINK_COLUMNS)
    .eq("invite_code", code)
    .maybeSingle<LinkRow>();

  if (error || !link) return null;

  const { data: patient } = await admin
    .from("patients")
    .select("id, name, owner_user_id")
    .eq("id", link.patient_id)
    .maybeSingle<{ id: string; name: string; owner_user_id: string }>();

  if (!patient) return null;

  return {
    id: link.id,
    status: link.status,
    consentGiven: link.consent_given,
    caregiverUserId: link.caregiver_user_id,
    createdAt: link.created_at,
    patientId: patient.id,
    patientOwnerId: patient.owner_user_id,
    patientFirstName: firstName(patient.name),
  };
}

/**
 * All caregiver links for a patient, enriched with the caregiver's display
 * name and masked phone.
 *
 * SECURITY: `patientId` must belong to the caller; the profile screen only
 * passes the id of a patient it already loaded with getSelectedPatient().
 */
export async function loadCaregiverLinks(
  patientId: string
): Promise<CaregiverLinkView[]> {
  const admin = createAdminClient();

  const { data: links, error } = await admin
    .from("caregiver_links")
    .select(LINK_COLUMNS)
    .eq("patient_id", patientId)
    .neq("status", "revoked")
    .order("created_at", { ascending: false });

  if (error || !links) return [];

  const rows = links as LinkRow[];
  const caregiverIds = [
    ...new Set(
      rows
        .map((row) => row.caregiver_user_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const names = new Map<string, { name: string | null; phone: string | null }>();
  if (caregiverIds.length > 0) {
    const { data: users } = await admin
      .from("users")
      .select("id, name, phone")
      .in("id", caregiverIds);
    for (const user of (users ?? []) as {
      id: string;
      name: string | null;
      phone: string | null;
    }[]) {
      names.set(user.id, { name: user.name, phone: user.phone });
    }
  }

  const now = Date.now();

  return rows.map((row) => {
    const caregiver = row.caregiver_user_id
      ? names.get(row.caregiver_user_id)
      : undefined;
    return {
      id: row.id,
      status: row.status,
      consent_given: row.consent_given,
      created_at: row.created_at,
      invite_code: row.invite_code,
      caregiver_user_id: row.caregiver_user_id,
      caregiver_name: caregiver?.name ?? null,
      caregiver_phone_masked: maskPhone(
        caregiver?.phone ?? row.caregiver_phone
      ),
      expired:
        row.status === "pending" &&
        row.caregiver_user_id === null &&
        now - Date.parse(row.created_at) > 48 * 60 * 60 * 1000,
    } satisfies CaregiverLinkView;
  });
}

/** Links held by a caregiver, for their "Patients" screen. */
export async function loadCaregiverPatients(
  caregiverUserId: string
): Promise<CaregiverPatientView[]> {
  const admin = createAdminClient();

  const { data: links, error } = await admin
    .from("caregiver_links")
    .select("id, status, consent_given, patient_id")
    .eq("caregiver_user_id", caregiverUserId)
    .neq("status", "revoked")
    .order("created_at", { ascending: false });

  if (error || !links) return [];

  const rows = links as {
    id: string;
    status: CaregiverLinkStatus;
    consent_given: boolean;
    patient_id: string;
  }[];

  const patientIds = [...new Set(rows.map((row) => row.patient_id))];
  const names = new Map<string, string>();
  if (patientIds.length > 0) {
    const { data: patients } = await admin
      .from("patients")
      .select("id, name")
      .in("id", patientIds);
    for (const patient of (patients ?? []) as { id: string; name: string }[]) {
      names.set(patient.id, patient.name);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    consent_given: row.consent_given,
    patient_id: row.patient_id,
    patient_name: firstName(names.get(row.patient_id)),
  }));
}
