"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "@/components/ui";
import type { AsNeededMedicine } from "@/lib/types";

/**
 * "As needed" medicines with a one-tap "Took one now" button. Logging posts to
 * /api/dose/adhoc, which writes a taken dose_log row at the current time and
 * decrements stock.
 */
export function AsNeededList({ items }: { items: AsNeededMedicine[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<
    { tone: "ok" | "error"; text: string } | null
  >(null);

  const logDose = useCallback(
    async (item: AsNeededMedicine) => {
      setMessage(null);
      setBusyId(item.schedule_id);
      try {
        const response = await fetch("/api/dose/adhoc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduleId: item.schedule_id }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error ?? "Could not log that dose.");
        }
        setMessage({ tone: "ok", text: `Logged ${item.name} just now.` });
        router.refresh();
      } catch (caught) {
        setMessage({
          tone: "error",
          text:
            caught instanceof Error
              ? caught.message
              : "Could not log that dose.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [router]
  );

  if (items.length === 0) return null;

  return (
    <Card className="space-y-3">
      <p className="text-[15px] font-semibold tracking-wide text-slate-500 uppercase">
        As needed
      </p>
      <ul className="space-y-3">
        {items.map((item) => {
          const busy = busyId === item.schedule_id;
          return (
            <li
              key={item.schedule_id}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate text-[17px] font-semibold text-slate-900">
                {item.name}
              </span>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0 px-4 text-[15px]"
                disabled={busy}
                onClick={() => logDose(item)}
              >
                {busy ? "Logging…" : "Took one now"}
              </Button>
            </li>
          );
        })}
      </ul>
      {message && (
        <p
          role="status"
          className={
            message.tone === "ok"
              ? "text-[15px] text-primary-700"
              : "text-[15px] text-red-700"
          }
        >
          {message.text}
        </p>
      )}
    </Card>
  );
}
