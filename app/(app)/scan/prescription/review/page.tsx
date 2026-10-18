import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getSelectedPatient } from "@/lib/patients";
import { Button, Card, PageHeader } from "@/components/ui";
import { PrescriptionReviewView } from "./prescription-review-view";

export const instant = false;

export default async function PrescriptionReviewPage() {
  await requireRole("patient");
  const patient = await getSelectedPatient();

  if (!patient) {
    return (
      <div className="space-y-4">
        <PageHeader title="Review" subtitle="Add a profile before scanning." />
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
        title="Review prescription"
        subtitle={`Check each medicine, then save to ${patient.name}'s cabinet.`}
      />
      <PrescriptionReviewView
        patientId={patient.id}
        patientName={patient.name}
        mealTimes={{
          breakfast: patient.breakfast_time,
          lunch: patient.lunch_time,
          dinner: patient.dinner_time,
        }}
      />
    </div>
  );
}
