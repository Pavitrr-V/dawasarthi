"use client";

import type { SafetyWarning } from "@/lib/types/safety";
import clsx from "clsx";

export function SafetyTab({
  warnings,
  loading,
  error,
}: {
  warnings: SafetyWarning[];
  loading?: boolean;
  error?: string | null;
}) {
  if (loading) {
    return <div className="py-3 text-sm text-gray-600">Checking safety...</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!warnings || warnings.length === 0) {
    return (
      <div className="py-3 text-sm text-gray-600">
        No active safety warnings for this profile.
      </div>
    );
  }

  const severityClass = (s: string) =>
    s === "severe"
      ? "text-red-700"
      : s === "moderate"
      ? "text-amber-700"
      : "text-gray-700";

  return (
    <div className="flex flex-col gap-2">
      {warnings.map((w, i) => (
        <div key={i} className="rounded-lg border p-3 flex flex-col gap-1">
          <div
            className={clsx("text-sm font-medium", severityClass(w.severity))}
          >
            {w.title} • {w.severity.toUpperCase()}
          </div>
          <div className="text-sm">{w.message}</div>
          {w.involved.length > 0 && (
            <div className="text-xs text-gray-600">
              Involved: {w.involved.join(", ")}
            </div>
          )}
          <div className="text-[11px] text-gray-500">
            Source: {w.source}
            {w.aiGenerated ? " • AI-generated, verify with pharmacist" : ""}
            {w.sourceUrl ? ` • ${w.sourceUrl}` : ""}
            {w.fetchedAt ? ` • ${w.fetchedAt}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}