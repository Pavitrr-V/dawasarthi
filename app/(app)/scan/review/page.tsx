import { connection } from "next/server";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getSelectedPatient } from "@/lib/patients";
import { Button, Card, PageHeader } from "@/components/ui";
import { ReviewView } from "@/components/scan/review-view";

export const instant = false;

export default async function ScanReviewPage() {
  await connection();
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
        title="Review & save"
        subtitle={`Check the details, then save to ${patient.name}'s cabinet.`}
      />
      <ReviewView />
    </div>
  );
}
