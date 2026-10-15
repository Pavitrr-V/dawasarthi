import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { BottomNav } from "@/components/bottom-nav";
import { Disclaimer } from "@/components/disclaimer";

export const instant = false;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 px-4 pt-5 pb-44">{children}</main>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md border-t border-slate-200 bg-white shadow-[0_-4px_16px_rgba(15,23,42,0.06)]">
        <Disclaimer />
        <BottomNav role={user.role} />
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}
