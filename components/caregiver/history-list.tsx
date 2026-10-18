import type { CaregiverHistoryRow } from "@/lib/types";
import { Card } from "@/components/ui";
import { StatusPill } from "./status-pill";

function formatDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

export function CaregiverHistoryList({
  history,
  limitLabel = "Recent doses",
}: {
  history: CaregiverHistoryRow[];
  limitLabel?: string;
}) {
  if (history.length === 0) {
    return (
      <Card className="text-[15px] text-slate-500">
        No dose history recorded yet.
      </Card>
    );
  }

  return (
    <section aria-label={limitLabel}>
      <ul className="space-y-2">
        {history.map((row) => (
          <li key={row.id}>
            <Card className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[17px] font-semibold text-slate-900">
                  {row.medicine_name}
                </p>
                <p className="text-[15px] text-slate-500">
                  {formatDateTime(row.due_at)}
                  {row.acted_at && row.acted_at !== row.due_at
                    ? ` · Acted ${formatDateTime(row.acted_at)}`
                    : ""}
                </p>
              </div>
              <StatusPill status={row.status} />
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
