"use client";

import { useEffect } from "react";

const POLL_MS = 5000;
const MAX_POLLS = 24; // ~2 minutes

/**
 * Fallback poll used while an online check is in flight.
 *
 * Saving a medicine fires POST /api/verify/start without waiting for it, so the
 * trust card starts in a "checking" state. Realtime normally delivers the
 * result, but when it is not enabled this component polls GET /api/verify/status
 * every POLL_MS until the job finishes (or MAX_POLLS is reached) and then calls
 * `onSettled` so the card can recompute its verdict.
 */
export function VerifyStatus({
  medicineId,
  onSettled,
}: {
  medicineId: string;
  onSettled: () => void;
}) {
  useEffect(() => {
    let attempts = 0;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      attempts += 1;
      try {
        const response = await fetch(
          `/api/verify/status?medicine_id=${encodeURIComponent(medicineId)}`,
          { cache: "no-store" }
        );
        if (response.ok) {
          const body = (await response.json()) as {
            status?: string;
            finished?: boolean;
          };
          if (body.finished === true || body.status === "done" || body.status === "failed") {
            stopped = true;
            window.clearInterval(timer);
            onSettled();
            return;
          }
        }
      } catch {
        // Offline: try again on the next tick.
      }

      if (attempts >= MAX_POLLS) {
        stopped = true;
        window.clearInterval(timer);
      }
    };

    const timer = window.setInterval(tick, POLL_MS);
    void tick();

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [medicineId, onSettled]);

  return (
    <span className="flex items-center gap-1.5 text-[13px] font-medium text-sky-700">
      <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
      Checking…
    </span>
  );
}
