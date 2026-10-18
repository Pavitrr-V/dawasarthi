import { connection } from "next/server";
import { requireRole } from "@/lib/auth";
import { getCaregiverDashboard } from "@/lib/caregiver-dashboard";
import { PageHeader } from "@/components/ui";
import { CaregiverDashboard } from "@/components/caregiver/caregiver-dashboard";

export const instant = false;

export default async function CaregiverDashboardPage() {
  await connection();
  const user = await requireRole("caregiver");
  const summaries = await getCaregiverDashboard();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome${user.name ? `, ${user.name.split(" ")[0]}` : ""}. Today's doses from your linked patients.`}
      />
      <CaregiverDashboard initial={summaries} />
    </div>
  );
}
