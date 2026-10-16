"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
} from "@/components/icons";
import { MedicineActions } from "@/components/medicine/medicine-actions";
import { VerifyStatus } from "@/components/medicine/verify-status";
import { DISCLAIMER } from "@/lib/constants";
import type { RiskLevel, RiskReason, RiskSeverity } from "@/lib/risk";

type OnlineChipStatus =
  | "checking"
  | "matched"
  | "not_found"
  | "failed"
  | "none";
type JobStatus = "queued" | "running" | "done" | "failed";

export type TrustCardProps = {
  medicineId: string;
  userId: string;
  initialRisk: { level: RiskLevel; reasons: RiskReason[] };
  alertCount: number;
  onlineStatus: OnlineChipStatus;
  jobStatus: JobStatus | null;
  lastCheckedAt: string | null;
  /** True when the latest online check is seed/demo data. */
  onlineDemo: boolean;
  expiresInDays: number | null;
  /** Times offered by the "Set reminder" sheet, from the patient profile. */
  reminderTimes: { label: string; time: string }[];
  hasStripImage: boolean;
  hasBoxImage: boolean;
  /** Server-rendered tab panels (kept on the server, switched on the client). */
  infoPanel: ReactNode;
  safetyPanel: ReactNode;
};

const LEVEL_STYLES: Record<
  RiskLevel,
  {
    card: string;
    badge: string;
    icon: string;
    title: string;
    subtitle: string;
  }
> = {
  green: {
    card: "border-emerald-200 bg-emerald-50",
    badge: "bg-emerald-200 text-emerald-900",
    icon: "text-emerald-600",
    title: "Looks fine",
    subtitle: "Our checks found no serious problems.",
  },
  amber: {
    card: "border-amber-200 bg-amber-50",
    badge: "bg-amber-200 text-amber-900",
    icon: "text-amber-600",
    title: "Check before use",
    subtitle: "A few things need your attention.",
  },
  red: {
    card: "border-red-200 bg-red-50",
    badge: "bg-red-200 text-red-900",
    icon: "text-red-600",
    title: "Do not use",
    subtitle: "A serious problem was found. Talk to a doctor or pharmacist.",
  },
};

const SEVERITY_DOT: Record<RiskSeverity, string> = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  info: "bg-slate-400",
};

function LevelIcon({
  level,
  className,
}: {
  level: RiskLevel;
  className?: string;
}) {
  if (level === "green") return <CheckCircleIcon className={className} />;
  if (level === "red") return <XCircleIcon className={className} />;
  return <AlertTriangleIcon className={className} />;
}

function expiryChip(days: number | null): { text: string; tone: string } {
  if (days === null) {
    return { text: "Expiry date missing", tone: "bg-slate-100 text-slate-600" };
  }
  if (days < 0) {
    return {
      text: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`,
      tone: "bg-red-100 text-red-800",
    };
  }
  if (days === 0) {
    return { text: "Expires today", tone: "bg-amber-100 text-amber-800" };
  }
  if (days <= 30) {
    return {
      text: `Expires in ${days} day${days === 1 ? "" : "s"}`,
      tone: "bg-amber-100 text-amber-800",
    };
  }
  return {
    text: `Expires in ${days} days`,
    tone: "bg-emerald-100 text-emerald-800",
  };
}

function onlineText(status: OnlineChipStatus): { label: string; tone: string } {
  switch (status) {
    case "checking":
      return { label: "Checking…", tone: "bg-sky-100 text-sky-800" };
    case "matched":
      return { label: "Matched", tone: "bg-emerald-100 text-emerald-800" };
    case "not_found":
      return { label: "Not found", tone: "bg-amber-100 text-amber-800" };
    case "failed":
      return { label: "Failed", tone: "bg-red-100 text-red-800" };
    default:
      return { label: "Not checked", tone: "bg-slate-100 text-slate-600" };
  }
}

type RecomputeResponse = {
  level?: RiskLevel;
  reasons?: RiskReason[];
  alertCount?: number;
  onlineStatus?: OnlineChipStatus;
  jobStatus?: JobStatus | null;
  lastCheckedAt?: string | null;
};

/**
 * Formats "Last checked" deterministically (fixed timezone) so the server
 * render and the client hydration always agree.
 */
function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * The /medicine/[id] trust card.
 *
 * The verdict colour is always decided by the deterministic engine on the
 * server (initial props) and refreshed through POST /api/risk/recompute. It
 * subscribes to Supabase Realtime on online_verifications so that, the moment
 * TinyFish writes a result, the card recomputes and recolours without a manual
 * refresh. While a check is still running it also renders <VerifyStatus>, which
 * polls GET /api/verify/status as a fallback when Realtime is unavailable.
 */
export function TrustCard({
  medicineId,
  userId,
  initialRisk,
  alertCount: initialAlertCount,
  onlineStatus: initialOnlineStatus,
  jobStatus: initialJobStatus,
  lastCheckedAt: initialLastCheckedAt,
  onlineDemo,
  expiresInDays,
  reminderTimes,
  hasStripImage,
  hasBoxImage,
  infoPanel,
  safetyPanel,
}: TrustCardProps) {
  const [level, setLevel] = useState<RiskLevel>(initialRisk.level);
  const [reasons, setReasons] = useState<RiskReason[]>(initialRisk.reasons);
  const [alertCount, setAlertCount] = useState(initialAlertCount);
  const [onlineStatus, setOnlineStatus] = useState<OnlineChipStatus>(
    initialOnlineStatus
  );
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(initialJobStatus);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(
    initialLastCheckedAt
  );
  const [tab, setTab] = useState<"info" | "safety">("info");
  const router = useRouter();

  const recompute = useCallback(async () => {
    try {
      const response = await fetch("/api/risk/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medicine_id: medicineId }),
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json()) as RecomputeResponse;
      if (Array.isArray(body.reasons)) setReasons(body.reasons);
      if (body.level === "green" || body.level === "amber" || body.level === "red") {
        setLevel(body.level);
      }
      if (typeof body.alertCount === "number") setAlertCount(body.alertCount);
      if (typeof body.onlineStatus === "string") {
        setOnlineStatus(body.onlineStatus);
      }
      if (body.jobStatus !== undefined) setJobStatus(body.jobStatus ?? null);
      if (body.lastCheckedAt !== undefined) {
        setLastCheckedAt(body.lastCheckedAt ?? null);
      }
    } catch {
      // Offline: keep the current verdict, the next event/poll retries.
    }
  }, [medicineId]);

  // Debounce bursts of realtime events into one recompute.
  const debounceRef = useRef<number | null>(null);
  const scheduledRecompute = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void recompute();
    }, 700);
  }, [recompute]);

  // Realtime: new online_verifications rows for this medicine. tinyfish_jobs is
  // intentionally NOT subscribed to: the client has no need to read job rows
  // (the status route is the only reader), so we keep the surface minimal.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`online-checks-${medicineId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "online_verifications",
          filter: `medicine_id=eq.${medicineId}`,
        },
        scheduledRecompute
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [medicineId, scheduledRecompute]);

  // Refresh once on mount so the persisted verdict matches the live data.
  // Scheduled (not called synchronously) so it is not a state update inside
  // the effect body.
  useEffect(() => {
    scheduledRecompute();
  }, [scheduledRecompute]);

  // Never fire a queued recompute after unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  // Called by <VerifyStatus> once a check finishes: recompute the verdict and
  // refresh the server-rendered panels.
  const handleSettled = useCallback(() => {
    void recompute();
    router.refresh();
  }, [recompute, router]);

  const style = LEVEL_STYLES[level];
  const expiry = useMemo(() => expiryChip(expiresInDays), [expiresInDays]);
  const checkedLabel = useMemo(() => formatCheckedAt(lastCheckedAt), [lastCheckedAt]);
  const online = onlineText(onlineStatus);
  const checking =
    onlineStatus === "checking" ||
    jobStatus === "queued" ||
    jobStatus === "running";

  return (
    <div className="space-y-4">
      <Card className={`space-y-4 ${style.card}`}>
        <div className="flex items-start gap-3">
          <LevelIcon level={level} className={`h-9 w-9 shrink-0 ${style.icon}`} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-wide text-slate-600 uppercase">
              Trust card
            </p>
            <p className="text-2xl font-bold text-slate-900">{style.title}</p>
            <p className="mt-0.5 text-[15px] text-slate-700">{style.subtitle}</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-[13px] font-bold uppercase ${style.badge}`}
          >
            {level}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-[13px] font-semibold ${expiry.tone}`}
          >
            {expiry.text}
          </span>
          <span className="rounded-full bg-white/70 px-3 py-1 text-[13px] font-semibold text-slate-600">
            {reasons.length} {reasons.length === 1 ? "note" : "notes"}
          </span>
        </div>

        {reasons.length > 0 ? (
          <ul className="space-y-2.5">
            {reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`} className="flex gap-2.5">
                <span
                  className={`mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_DOT[reason.severity]}`}
                />
                <div className="min-w-0">
                  <p className="text-[15px] leading-snug text-slate-800">
                    {reason.message_en}
                  </p>
                  <p className="text-[14px] leading-snug text-slate-500">
                    {reason.message_hi}
                  </p>
                  {(reason.source_url || reason.demo) && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      {reason.demo && (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold tracking-wide text-slate-600 uppercase">
                          Demo data
                        </span>
                      )}
                      {reason.source_url && (
                        <a
                          href={reason.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[13px] font-semibold text-primary-700 underline"
                        >
                          Source
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-slate-700">
            Nothing concerning found for this medicine.
          </p>
        )}
      </Card>

      {/* Online checks strip */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Online checks
          </p>
          {checking && (
            <VerifyStatus medicineId={medicineId} onSettled={handleSettled} />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chip
            label="Official alerts"
            value={alertCount > 0 ? `${alertCount} found` : "Checked"}
            tone={
              alertCount > 0
                ? "bg-red-100 text-red-800"
                : "bg-emerald-100 text-emerald-800"
            }
          />
          <Chip label="Online listing" value={online.label} tone={online.tone} />
          <Chip
            label="Last checked"
            value={checkedLabel ?? "Not yet"}
            tone="bg-slate-100 text-slate-600"
          />
          {onlineDemo && (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold tracking-wide text-slate-600 uppercase">
              Demo data
            </span>
          )}
        </div>
      </Card>

      {/* Tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
        {(["info", "safety"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`min-h-[44px] rounded-lg text-[16px] font-semibold capitalize transition-colors ${
              tab === value
                ? "bg-white text-primary-700 shadow-sm"
                : "text-slate-500"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      <div>{tab === "info" ? infoPanel : safetyPanel}</div>

      <MedicineActions
        medicineId={medicineId}
        userId={userId}
        reminderTimes={reminderTimes}
        hasStripImage={hasStripImage}
        hasBoxImage={hasBoxImage}
        onChanged={scheduledRecompute}
      />

      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
    </div>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className={`rounded-xl px-3 py-1.5 ${tone}`}>
      <p className="text-[11px] font-semibold tracking-wide uppercase opacity-80">
        {label}
      </p>
      <p className="text-[14px] font-bold">{value}</p>
    </div>
  );
}
