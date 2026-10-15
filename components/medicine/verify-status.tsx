"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 6000;
const MAX_ATTEMPTS = 10;

/**
 * Phase 3B placeholder.
 *
 * Saving a medicine fires POST /api/verify/start without waiting for it, so
 * the trust card starts in a "running" state. This component polls the (not
 * yet built) status route and refreshes the server-rendered trust card once
 * the online check finishes.
 *
 * TODO(Phase 3B): /api/verify/start and /api/verify/status do not exist yet.
 * While they are missing the poll answers 404, which is ignored on purpose,
 * so the card keeps showing "Online check running…".
 */
export function VerifyStatus({ medicineId }: { medicineId: string }) {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    async function check() {
      if (cancelled) return;
      attempts += 1;
      try {
        const response = await fetch(
          `/api/verify/status?medicine_id=${encodeURIComponent(medicineId)}`,
          { cache: "no-store" }
        );
        if (response.ok) {
          const body = (await response.json()) as { status?: string };
          if (body.status === "done" || body.status === "failed") {
            cancelled = true;
            window.clearInterval(timer);
            router.refresh();
            return;
          }
        }
        // Every other response (including 404 while the route is unbuilt) is
        // ignored: we try again on the next tick.
      } catch {
        // Offline: try again on the next tick.
      }

      if (!cancelled && attempts >= MAX_ATTEMPTS) {
        window.clearInterval(timer);
        setTimedOut(true);
      }
    }

    const timer = window.setInterval(check, POLL_MS);
    check();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [medicineId, router]);

  if (timedOut) {
    return (
      <p className="text-sm text-slate-500">
        Online check is taking longer than expected. Refresh the page in a
        moment.
      </p>
    );
  }

  return (
    <p className="flex items-center gap-2 text-[15px] font-medium text-primary-700">
      <span className="h-2 w-2 animate-pulse rounded-full bg-primary-500" />
      Online check running…
    </p>
  );
}
