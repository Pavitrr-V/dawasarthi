"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { WarningBanner } from "@/components/safety/WarningBanner";
import type { SafetyWarning } from "@/lib/types/safety";
import { runSafetyCheckForPatient } from "@/lib/actions/safety-check";
import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";

type Dose = {
  id: string;
  due_at: string;
  status: "pending" | "taken" | "skipped" | "snoozed" | "missed";
  medicineName: string;
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const GROUPS = [
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "evening", label: "Evening" },
  { key: "night", label: "Night" },
] as const;

// IST day boundaries expressed as UTC ISO strings
function istDayRange(): { start: string; end: string } {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  const startShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  return {
    start: new Date(startShifted - IST_OFFSET_MS).toISOString(),
    end: new Date(startShifted + 24 * 60 * 60 * 1000 - IST_OFFSET_MS).toISOString(),
  };
}

function groupOf(iso: string): (typeof GROUPS)[number]["key"] {
  const h = new Date(new Date(iso).getTime() + IST_OFFSET_MS).getUTCHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

const STATUS_STYLE: Record<Dose["status"], string> = {
  pending: "bg-slate-100 text-slate-700",
  snoozed: "bg-sky-100 text-sky-800",
  taken: "bg-emerald-100 text-emerald-800",
  skipped: "bg-amber-100 text-amber-800",
  missed: "bg-red-100 text-red-800",
};

export function HomeClient({ patientId }: { patientId: string | null }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [doses, setDoses] = useState<Dose[]>([]);
  const [warnings, setWarnings] = useState<SafetyWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadDoses = useCallback(
    async (pid: string) => {
      const { start, end } = istDayRange();
      const { data, error } = await supabase
        .from("dose_logs")
        .select("id, due_at, status, schedules(medicines(name))")
        .eq("patient_id", pid)
        .gte("due_at", start)
        .lt("due_at", end)
        .order("due_at", { ascending: true });

      if (error) throw new Error(error.message);

      setDoses(
        (data ?? []).map((row: any) => {
          const sched = Array.isArray(row.schedules) ? row.schedules[0] : row.schedules;
          const med = Array.isArray(sched?.medicines) ? sched.medicines[0] : sched?.medicines;
          return {
            id: row.id,
            due_at: row.due_at,
            status: row.status,
            medicineName: med?.name ?? "Medicine",
          } as Dose;
        })
      );
    },
    [supabase]
  );

  // initial load: doses + safety check
  useEffect(() => {
    if (!patientId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        await loadDoses(patientId);
      } catch (e: any) {
        if (!cancelled) setErr(e.message || "Failed to load doses");
      } finally {
        if (!cancelled) setLoading(false);
      }
      // safety check must never break the page
      try {
        const res = await runSafetyCheckForPatient(patientId);
        if (!cancelled) setWarnings(res?.warnings ?? []);
      } catch (e) {
        console.error("[home] safety check failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, loadDoses]);

  // realtime: refresh when dose_logs change
  useEffect(() => {
    if (!patientId) return;
    const channel = supabase
      .channel(`home-doses-${patientId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dose_logs", filter: `patient_id=eq.${patientId}` },
        () => {
          loadDoses(patientId).catch((e) => console.error(e));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, patientId, loadDoses]);

  async function act(id: string, action: "taken" | "skipped" | "snooze") {
    setBusyId(id);
    setErr(null);
    try {
      const res = await fetch(`/api/dose/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Action failed (${res.status})`);
      }
      if (patientId) await loadDoses(patientId);
    } catch (e: any) {
      setErr(e.message || "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const done = doses.filter((d) => d.status === "taken").length;

  return (
    <div className="flex flex-col gap-4 py-3">
      <h1 className="text-2xl font-bold text-slate-900">Home</h1>

      <WarningBanner warnings={warnings} onView={() => {}} />

      {err && <div className="rounded-xl bg-red-50 p-3 text-base text-red-700">{err}</div>}

      {loading ? (
        <div className="space-y-3">
          <div className="h-20 animate-pulse rounded-2xl bg-slate-200" />
          <div className="h-20 animate-pulse rounded-2xl bg-slate-200" />
        </div>
      ) : !patientId ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-base text-slate-600">
          No patient profile yet. Create one to see today&apos;s doses.
        </div>
      ) : doses.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-base text-slate-600">
          No doses scheduled for today. Set a reminder from a medicine&apos;s page.
        </div>
      ) : (
        <>
          <p className="text-base text-slate-600">
            Today: {done} of {doses.length} taken
          </p>

          {GROUPS.map((g) => {
            const items = doses.filter((d) => groupOf(d.due_at) === g.key);
            if (items.length === 0) return null;
            return (
              <section key={g.key} className="space-y-2">
                <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
                  {g.label}
                </h2>
                <ul className="space-y-3">
                  {items.map((d) => {
                    const open = d.status === "pending" || d.status === "snoozed";
                    return (
                      <li
                        key={d.id}
                        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-lg font-semibold text-slate-900">
                              {d.medicineName}
                            </p>
                            <p className="text-base text-slate-600">{timeLabel(d.due_at)}</p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium capitalize ${STATUS_STYLE[d.status]}`}
                          >
                            {d.status}
                          </span>
                        </div>

                        {open && (
                          <div className="mt-3 grid grid-cols-3 gap-2">
                            <button
                              disabled={busyId === d.id}
                              onClick={() => act(d.id, "taken")}
                              className="min-h-12 rounded-xl bg-teal-600 px-2 text-base font-semibold text-white disabled:opacity-50"
                            >
                              Taken
                            </button>
                            <button
                              disabled={busyId === d.id}
                              onClick={() => act(d.id, "skipped")}
                              className="min-h-12 rounded-xl border border-slate-300 bg-white px-2 text-base font-semibold text-slate-700 disabled:opacity-50"
                            >
                              Skip
                            </button>
                            <button
                              disabled={busyId === d.id}
                              onClick={() => act(d.id, "snooze")}
                              className="min-h-12 rounded-xl border border-slate-300 bg-white px-2 text-base font-semibold text-slate-700 disabled:opacity-50"
                            >
                              Snooze
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}