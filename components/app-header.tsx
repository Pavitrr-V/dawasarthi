"use client";

import Link from "next/link";
import { usePatient } from "@/lib/patient-context";
import type { Role } from "@/lib/types";

export function AppHeader({ role }: { role: Role }) {
  const { patients, selected, selectPatient, isSwitching } = usePatient();

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
      {patients.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-slate-500">
            Viewing
          </span>
          <select
            aria-label="Switch profile"
            value={selected?.id ?? ""}
            onChange={(e) => selectPatient(e.target.value)}
            disabled={isSwitching}
            className="min-h-[44px] flex-1 rounded-xl border border-slate-300 bg-white px-3 text-[17px] font-semibold text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:opacity-60"
          >
            {patients.map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.name}
                {patient.age !== null ? ` (${patient.age})` : ""}
              </option>
            ))}
          </select>
          <Link
            href="/patients/new"
            aria-label="Add a profile"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-300 text-xl font-semibold text-primary-700 hover:bg-primary-50"
          >
            +
          </Link>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-slate-900">MedScan</span>
          {role === "patient" && (
            <Link
              href="/patients/new"
              className="text-[15px] font-semibold text-primary-700"
            >
              Add profile
            </Link>
          )}
        </div>
      )}
    </header>
  );
}
