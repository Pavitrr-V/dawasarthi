import type { DoseStatus } from "@/lib/types";

const LABEL: Record<DoseStatus, string> = {
  pending: "Pending",
  taken: "Taken",
  missed: "Missed",
  skipped: "Skipped",
  snoozed: "Snoozed",
};

const STYLE: Record<DoseStatus, string> = {
  taken: "bg-emerald-100 text-emerald-800 border border-emerald-200",
  pending: "bg-slate-100 text-slate-600 border border-slate-200",
  missed: "bg-red-100 text-red-700 border border-red-200",
  skipped: "bg-amber-100 text-amber-800 border border-amber-200",
  snoozed: "bg-sky-100 text-sky-700 border border-sky-200",
};

export function StatusPill({ status }: { status: DoseStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[13px] font-semibold ${STYLE[status]}`}
      aria-label={`Dose status: ${LABEL[status]}`}
    >
      {LABEL[status]}
    </span>
  );
}
