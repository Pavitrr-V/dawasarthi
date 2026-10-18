"use client";

import { useEffect, useState } from "react";
import { WarningBanner } from "@/components/safety/WarningBanner";
import type { SafetyWarning } from "@/lib/types/safety";
import { runSafetyCheckForPatient } from "@/lib/actions/safety-check";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function HomePage() {
  const supabase = createSupabaseBrowserClient();
  const [warnings, setWarnings] = useState<SafetyWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [patientId, setPatientId] = useState<string | null>(null);

  function getCookie(name: string): string | null {
    if (typeof document === "undefined") return null;
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop()?.split(";").shift() || null;
    return null;
  }

  useEffect(() => {
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        const { data: user } = await supabase.auth.getUser();
        if (!user?.user) throw new Error("Sign in required");
        const cookiePid = getCookie("selected_patient_id");
        let pid = cookiePid;
        if (!pid) {
          const { data: patients } = await supabase
            .from("patients")
            .select("id")
            .limit(1);
          pid = patients?.[0]?.id || null;
        }
        if (!pid) {
          setWarnings([]);
          return;
        }
        setPatientId(pid);
        const res = await runSafetyCheckForPatient(pid);
        setWarnings(res.warnings);
      } catch (e: any) {
        setErr(e.message || "Failed to load safety");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [supabase]);

  return (
    <div className="py-3 flex flex-col gap-2">
      <h1 className="text-lg font-semibold">Home</h1>
      <WarningBanner
        warnings={warnings}
        onView={() => {
          // navigate to trust card/safety tab
        }}
      />
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}