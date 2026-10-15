import { requireRole } from "@/lib/auth";
import { EmptyState, PageHeader } from "@/components/ui";

export default async function CaregiverPatientsPage() {
  await requireRole("caregiver");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Patients"
        subtitle="Link to a patient using the invite code they share with you."
      />
      <EmptyState
        title="No linked patients"
        description="Once a patient approves your request, they will show up here with their medicines and dose alerts."
      />
    </div>
  );
}
