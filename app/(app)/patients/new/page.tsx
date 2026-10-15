import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";

export const instant = false;

export default async function NewPatientPage() {
  await requireRole("patient");

  return (
    <div className="space-y-4">
      <Link
        href="/profile"
        className="text-[15px] font-semibold text-primary-700"
      >
        ← Back
      </Link>
      <PageHeader
        title="Add a profile"
        subtitle="Details used to check medicines and set reminders."
      />
      <PatientForm />
    </div>
  );
}
