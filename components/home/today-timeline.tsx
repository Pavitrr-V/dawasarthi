"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card } from "@/components/ui";
import { groupByDayPart, istClockLabel } from "@/lib/schedule";
import type { DoseStatus, TimelineDose } from "@/lib/types";

/**
 * Today's doses, grouped Morning / Afternoon / Evening / Night, with big
 * Taken / Skip / Snooze buttons.
 *
 * The list is server-rendered and passed in as `doses`; a Supabase Realtime
 * subscription on `dose_logs` calls router.refresh() so the timeline stays in
 * sync with actions taken here, in another tab, or from a push notification.
 */

type Action = "taken" | "skipped" | "snooze";

const STATUS_BY_ACTION: Record<Action, DoseStatus> = {
  taken: "taken",
  skipped: "skipped",
  snooze: "snoozed",
};

const STATUS_LABEL: Record<DoseStatus, string> = {
  pending: "Due",
  taken: "Taken",
  skipped: "Skipped",
  snoozed: "Snoozed",
  missed: "Missed",
};

const STATUS_STYLE: Record<DoseStatus, string> = {
  pending: "bg-slate-100 text-slate-600",
  taken: "bg-emerald-100 text-emerald-800",
  skipped: "bg-slate-100 text-slate-600",
  snoozed: "bg-amber-100 text-amber-800",
  missed: "bg-red-100 text-red-700",
};

export function TodayTimeline({
  patientId,
  doses: serverDoses,
}: {
  patientId: string;
  doses: TimelineDose[];
}) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, DoseStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When a refresh delivers new server data, drop the optimistic overrides.
  // Adjusting state during render (instead of in an effect) is the pattern
  // React recommends, and avoids a cascading render.
  const [lastServer, setLastServer] = useState(serverDoses);
  if (lastServer !== serverDoses) {
    setLastServer(serverDoses);
    setOverrides({});
  }

  const doses = useMemo(
    () =>
      serverDoses.map((dose) => {
        const override = overrides[dose.id];
        return override ? { ...dose, status: override } : dose;
      }),
    [serverDoses, overrides]
  );

  // --- Realtime: any change to this patient's dose_logs refreshes the page. --
  const debounceRef = useRef<number | null>(null);
  const scheduledRefresh = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      router.refresh();
    }, 500);
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`dose-logs-${patientId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "dose_logs",
          filter: `patient_id=eq.${patientId}`,
        },
        scheduledRefresh
      )
      .subscribe();

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [patientId, scheduledRefresh]);

  const act = useCallback(
    async (dose: TimelineDose, action: Action) => {
      setError(null);
      setBusyId(dose.id);

      // Optimistic: flip the row immediately, roll back if the write fails.
      setOverrides((current) => ({
        ...current,
        [dose.id]: STATUS_BY_ACTION[action],
      }));

      try {
        const response = await fetch(`/api/dose/${dose.id}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? "Could not record that. Please try again.");
        }
        router.refresh();
      } catch (caught) {
        setOverrides((current) => {
          const next = { ...current };
          delete next[dose.id];
          return next;
        });
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not record that. Please try again."
        );
      } finally {
        setBusyId(null);
      }
    },
    [router]
  );

  const groups = useMemo(() => groupByDayPart(doses), [doses]);

  if (doses.length === 0) {
    return (
      <Card className="space-y-1 text-center">
        <p className="text-[17px] font-semibold text-slate-800">
          No doses today
        </p>
        <p className="text-[15px] text-slate-500">
          Scan a medicine and set a reminder to build your timeline.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[15px] text-red-700"
        >
          {error}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.part} className="space-y-2">
          <h2 className="text-[15px] font-semibold tracking-wide text-slate-500 uppercase">
            {group.part}
          </h2>
          <ul className="space-y-2">
            {group.items.map((dose) => {
              const actionable =
                dose.status === "pending" || dose.status === "snoozed";
              const busy = busyId === dose.id;
              return (
                <li key={dose.id}>
                  <Card className="space-y-3 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[17px] font-semibold text-slate-900">
                          {dose.medicine_name}
                        </p>
                        <p className="text-[15px] text-slate-500">
                          {istClockLabel(dose.due_at)}
                          {dose.status === "snoozed" ? " · snoozed" : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {dose.course && (
                          <span className="rounded-full bg-primary-50 px-2.5 py-0.5 text-[12px] font-bold text-primary-800">
                            {dose.course}
                          </span>
                        )}
                        {!actionable && (
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${STATUS_STYLE[dose.status]}`}
                          >
                            {STATUS_LABEL[dose.status]}
                          </span>
                        )}
                      </div>
                    </div>

                    {actionable && (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          <Button
                            type="button"
                            className="px-2 text-[15px]"
                            disabled={busy}
                            onClick={() => act(dose, "taken")}
                          >
                            Taken
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2 text-[15px]"
                            disabled={busy}
                            onClick={() => act(dose, "skipped")}
                          >
                            Skip
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2 text-[15px]"
                            disabled={busy}
                            onClick={() => act(dose, "snooze")}
                          >
                            Snooze
                          </Button>
                        </div>
                        <p className="text-[13px] text-slate-400">
                          Snooze moves this dose 10 minutes ahead.
                        </p>
                      </>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
