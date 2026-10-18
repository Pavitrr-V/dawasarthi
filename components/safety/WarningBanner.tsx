"use client";

import type { SafetyWarning } from "@/lib/types/safety";
import clsx from "clsx";

export function WarningBanner({
  warnings,
  onView,
}: {
  warnings: SafetyWarning[];
  onView?: () => void;
}) {
  if (!warnings || warnings.length === 0) return null;

  const severe = warnings.some((w) => w.severity === "severe");
  const bg = severe ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200";
  const text = severe ? "text-red-800" : "text-amber-800";

  return (
    <div
      className={clsx("rounded-lg border p-3 flex flex-col gap-1", bg, text)}
      role="alert"
      aria-live="polite"
    >
      <div className="text-sm font-semibold">
        Safety warnings: {warnings.length} active issue
        {warnings.length > 1 ? "s" : ""}
      </div>
      <div className="text-xs line-clamp-2">
        {warnings[0].message}
        {warnings.length > 1 ? " • + more" : ""}
      </div>
      {onView && (
        <button
          onClick={onView}
          className="mt-1 self-start min-h-[44px] px-2 text-xs underline"
          aria-label="View safety details"
        >
          View details
        </button>
      )}
    </div>
  );
}