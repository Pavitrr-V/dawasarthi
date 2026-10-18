"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui";
import { istClockLabel } from "@/lib/schedule";
import { adherenceLabel } from "@/lib/adherence";
import { StatusPill } from "./status-pill";
import type { CaregiverPatientSummary } from "@/lib/types";

function PatientCard({ summary }: { summary: CaregiverPatientSummary }) {
  const { patient, doses, adherence } = summary;
  const sortedDoses = [...doses].sort(
    (a, b) => Date.parse(a.due_at) - Date.parse(b.due_at)
  );

  return (
    <Card className="space-y-3">
      <Link
        href={`/caregiver/patients/${patient.id}`}
        className="block -m-4 rounded-2xl p-4 min-h-[48px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        aria-label={`View details for ${patient.name}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[19px] font-bold text-slate-900">
              {patient.name}
            </p>
            <p className="text-[15px] text-slate-600">
              Weekly adherence: {adherenceLabel(adherence)}
            </p>
          </div>
          <span className="text-[15px] font-semibold text-primary-700">
            View details →
          </span>
        </div>
      </Link>

      <div className="space-y-2" aria-label={`Today’s doses for ${patient.name}`}>
        {sortedDoses.length === 0 ? (
          <p className="text-[15px] text-slate-500">No doses today</p>
        ) : (
          sortedDoses.map((dose) => (
            <div
              key={dose.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[17px] font-semibold text-slate-900">
                  {dose.medicine_name}
                </p>
                <p className="text-[15px] text-slate-500">
                  {istClockLabel(dose.due_at)}
                </p>
              </div>
              <StatusPill status={dose.status} />
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

function EmptyCard() {
  return (
    <Card className="space-y-3 py-6 text-center">
      <p className="text-lg font-semibold text-slate-900">No linked patients</p>
      <p className="text-[15px] text-slate-500">
        Ask a patient for their invite code to connect and see today’s doses.
      </p>
      <Link
        href="/join"
        className="inline-flex min-h-[48px] items-center justify-center rounded-xl bg-primary-600 px-5 text-[17px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        Enter an invite code
      </Link>
    </Card>
  );
}

export function CaregiverDashboard({
  initial,
}: {
  initial: CaregiverPatientSummary[];
}) {
  const router = useRouter();
  const [realtimeFailed, setRealtimeFailed] = useState(false);
  const debounceRef = useRef<number | null>(null);

  const scheduledRefresh = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      router.refresh();
    }, 500);
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("caregiver-dashboard-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dose_logs" },
        scheduledRefresh
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "caregiver_links" },
        scheduledRefresh
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeFailed(false);
          return;
        }
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setRealtimeFailed(true);
        }
      });

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [scheduledRefresh]);

  useEffect(() => {
    if (!realtimeFailed) return;
    const id = window.setInterval(() => {
      router.refresh();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [realtimeFailed, router]);

  if (initial.length === 0) {
    return <EmptyCard />;
  }

  return (
    <div className="space-y-4">
      {realtimeFailed && (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-center text-[15px] font-medium text-amber-800"
        >
          Live updates unavailable — refreshing every 30s.
        </p>
      )}
      {initial.map((summary) => (
        <PatientCard key={summary.patient.id} summary={summary} />
      ))}
    </div>
  );
}
