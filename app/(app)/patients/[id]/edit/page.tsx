import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { getOwnedPatient } from "@/lib/patients";
import { PageHeader } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { deletePatient } from "@/app/(app)/patient-actions";

export const instant = false;

export default async function EditPatientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole("patient");
  const { id } = await params;

  const patient = await getOwnedPatient(id);
  if (!patient) notFound();

  return (
    <div className="space-y-4">
      <Link
        href="/profile"
        className="text-[15px] font-semibold text-primary-700"
      >
        ← Back
      </Link>
      <PageHeader title="Edit profile" subtitle={patient.name} />

      <PatientForm patient={patient} />

      <form action={deletePatient} className="pt-2">
        <input type="hidden" name="id" value={patient.id} />
        <ConfirmSubmitButton
          message="Delete this profile? This cannot be undone."
          className="w-full border-red-200 text-red-700 hover:bg-red-50"
        >
          Delete this profile
        </ConfirmSubmitButton>
      </form>
    </div>
  );
}
