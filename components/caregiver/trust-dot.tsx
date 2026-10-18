import type { RiskLevel } from "@/lib/risk";

const STYLE: Record<RiskLevel | "none", string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  none: "bg-slate-300",
};

const LABEL: Record<RiskLevel | "none", string> = {
  green: "Green",
  amber: "Amber",
  red: "Red",
  none: "Not checked",
};

export function TrustDot({ level }: { level: RiskLevel | null }) {
  const key = level ?? "none";
  return (
    <span
      className="inline-flex items-center gap-2 text-[15px] text-slate-600"
      aria-label={`Trust level: ${LABEL[key]}`}
    >
      <span
        className={`h-3 w-3 rounded-full ${STYLE[key]}`}
        aria-hidden="true"
      />
      <span className="text-[15px]">{LABEL[key]}</span>
    </span>
  );
}
