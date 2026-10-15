import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getSelectedPatient } from "@/lib/patients";
import { Button, Card, PageHeader } from "@/components/ui";
import { MedicineForm } from "@/components/scan/medicine-form";
import { EMPTY_EXTRACTION } from "@/lib/review";

export const instant = false;

export default async function ManualEntryPage() {
  await requireRole("patient");
  const patient = await getSelectedPatient();

  if (!patient) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Manual entry"
          subtitle="Add a profile before adding medicines."
        />
        <Card className="space-y-3">
          <p className="text-[15px] text-slate-600">
            You need a patient profile before adding medicines.
          </p>
          <Link href="/patients/new" className="block">
            <Button className="w-full">Add a profile</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Manual entry"
        subtitle={`Type the details to add a medicine to ${patient.name}'s cabinet.`}
      />
      {/* Same form as /scan/review, but empty and with no photos. */}
      <MedicineForm
        initial={EMPTY_EXTRACTION}
        imagePaths={[]}
        mode="medicine"
        source="manual"
      />
    </div>
  );
}
