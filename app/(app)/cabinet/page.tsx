import { requireRole } from "@/lib/auth";
import { EmptyState, PageHeader } from "@/components/ui";

export default async function CabinetPage() {
  await requireRole("patient");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cabinet"
        subtitle="Your scanned medicines live here with stock and expiry."
      />
      <EmptyState
        title="Your cabinet is empty"
        description="Scan your first medicine to add it here."
      />
    </div>
  );
}
