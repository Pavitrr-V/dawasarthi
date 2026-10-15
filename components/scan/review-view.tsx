"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { MedicineForm } from "@/components/scan/medicine-form";
import {
  getReviewPayload,
  getReviewServerSnapshot,
  type ReviewPayload,
} from "@/lib/review";

/** The payload never changes while this page is open, so nothing to subscribe to. */
function subscribe(): () => void {
  return () => {};
}

/**
 * Reads the extraction handed over by the scan screen (sessionStorage, so it
 * is per-tab) and renders the editable review form. On the server the
 * snapshot is undefined, so the first paint is a loading card.
 */
export function ReviewView() {
  const payload: ReviewPayload | null | undefined = useSyncExternalStore(
    subscribe,
    getReviewPayload,
    getReviewServerSnapshot
  );

  if (payload === undefined) {
    return (
      <Card className="space-y-3">
        <p className="text-[15px] text-slate-500">Loading your scan…</p>
        <div className="animate-pulse space-y-2">
          <div className="h-4 w-2/3 rounded bg-slate-200" />
          <div className="h-4 w-1/2 rounded bg-slate-200" />
          <div className="h-4 w-3/4 rounded bg-slate-200" />
        </div>
      </Card>
    );
  }

  if (!payload) {
    return (
      <Card className="space-y-3">
        <p className="text-[15px] font-semibold text-slate-800">
          Nothing to review
        </p>
        <p className="text-[15px] text-slate-600">
          We could not find scan results in this tab. Scan the medicine again,
          or type the details yourself.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Link href="/scan" className="block">
            <Button className="w-full">Scan again</Button>
          </Link>
          <Link href="/scan/manual" className="block">
            <Button variant="secondary" className="w-full">
              Manual entry
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <MedicineForm
      initial={payload.extraction}
      imagePaths={payload.imagePaths}
      mode={payload.mode}
      source="scan"
      datasetMatch={payload.datasetMatch}
    />
  );
}
