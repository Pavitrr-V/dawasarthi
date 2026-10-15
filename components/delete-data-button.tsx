"use client";

import { useState, useTransition } from "react";
import { deleteAllMyData } from "@/app/(app)/patient-actions";
import { Button } from "@/components/ui";
import { DISCLAIMER } from "@/lib/constants";

export function DeleteDataButton() {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirmDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAllMyData();
      if (result?.error) setError(result.error);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="w-full border-red-200 text-red-700 hover:bg-red-50"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Delete all my data
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="text-lg font-bold text-slate-900">
              Delete all my data?
            </h2>
            <p className="mt-2 text-[15px] text-slate-600">
              This permanently removes your profiles, medicines, schedules, dose
              history, reports and uploaded files. This cannot be undone.
            </p>
            <p className="mt-2 text-sm text-slate-400">{DISCLAIMER}</p>

            {error && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
                {error}
              </div>
            )}

            <div className="mt-4 space-y-2">
              <Button
                type="button"
                disabled={pending}
                className="w-full bg-red-600 hover:bg-red-700 disabled:bg-red-300"
                onClick={confirmDelete}
              >
                {pending ? "Deleting..." : "Yes, delete everything"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
