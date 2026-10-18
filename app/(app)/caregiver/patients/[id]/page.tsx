import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import {
  getCaregiverPatient,
  getPatientMedicines,
  getPatientHistory,
} from "@/lib/caregiver-dashboard";
import { PageHeader } from "@/components/ui";
import { CaregiverMedicineList } from "@/components/caregiver/medicine-list";
import { CaregiverHistoryList } from "@/components/caregiver/history-list";

export const instant = false;

export default async function CaregiverPatientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  await requireRole("caregiver");
  const { id } = await params;

  const patient = await getCaregiverPatient(id);
  if (!patient) {
    notFound();
  }

  const [medicines, history] = await Promise.all([
    getPatientMedicines(id),
    getPatientHistory(id, 50),
  ]);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/caregiver/patients"
          className="inline-flex min-h-[44px] items-center gap-2 text-[15px] font-semibold text-primary-700"
        >
          ← Back to patients
        </Link>
        <PageHeader title={patient.name} subtitle="Read-only view of medicines and dose history" />
      </div>

      <p className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-[15px] text-slate-600">
        This is a read-only view. Caregivers cannot add medicines, set reminders,
        or change doses.
      </p>

      <section aria-label="Medicines" className="space-y-2">
        <h2 className="text-[17px] font-semibold text-slate-900">Medicines</h2>
        <CaregiverMedicineList medicines={medicines} />
      </section>

      <section aria-label="Dose history" className="space-y-2">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Recent doses (last 50)
        </h2>
        <CaregiverHistoryList history={history} />
      </section>
    </div>
  );
}
