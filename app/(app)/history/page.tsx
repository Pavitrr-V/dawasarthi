import { requireRole } from "@/lib/auth";
import { EmptyState, PageHeader } from "@/components/ui";

export default async function HistoryPage() {
  await requireRole("patient");

  return (
    <div className="space-y-4">
      <PageHeader
        title="History"
        subtitle="A daily log of taken, skipped, and missed doses."
      />
      <EmptyState
        title="No doses recorded yet"
        description="Set a reminder for a medicine to start tracking doses."
      />
    </div>
  );
}
