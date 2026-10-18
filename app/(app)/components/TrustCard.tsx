"use client";

import { useState } from "react";
import { SafetyTab } from "@/components/safety/SafetyTab";
import type { SafetyWarning } from "@/lib/types/safety";

export type TrustColor = "green" | "amber" | "red";

export function TrustCard({
  trustColor,
  warnings,
  loadingSafety,
  safetyError,
}: {
  trustColor: TrustColor;
  warnings: SafetyWarning[];
  loadingSafety?: boolean;
  safetyError?: string | null;
}) {
  const [tab, setTab] = useState<"overview" | "safety">("overview");

  return (
    <div className="rounded-xl border p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="font-medium">Trust card</div>
        <div
          className={`h-2.5 w-2.5 rounded-full ${
            trustColor === "green"
              ? "bg-green-500"
              : trustColor === "amber"
              ? "bg-amber-500"
              : "bg-red-500"
          }`}
        />
      </div>
      <div className="flex gap-1">
        <button
          onClick={() => setTab("overview")}
          className={`min-h-[44px] px-3 rounded-full border text-sm ${
            tab === "overview" ? "bg-gray-900 text-white" : "bg-white"
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setTab("safety")}
          className={`min-h-[44px] px-3 rounded-full border text-sm ${
            tab === "safety" ? "bg-gray-900 text-white" : "bg-white"
          }`}
        >
          Safety
        </button>
      </div>
      {tab === "overview" && (
        <div className="text-sm text-gray-600">
          Deterministic risk check. See Safety tab for duplicates, allergies,
          interactions.
        </div>
      )}
      {tab === "safety" && (
        <SafetyTab
          warnings={warnings}
          loading={loadingSafety}
          error={safetyError}
        />
      )}
      <div className="text-[11px] text-gray-500 mt-1">
        Risk check only; not medical advice. Consult a doctor or pharmacist.
      </div>
    </div>
  );
}