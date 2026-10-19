"use client";

import { useRouter } from "next/navigation";

export function RetryButton({ label = "Retry" }: { label?: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.refresh()}
      className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-4 py-2 text-[14px] font-semibold text-slate-700"
    >
      {label}
    </button>
  );
}
