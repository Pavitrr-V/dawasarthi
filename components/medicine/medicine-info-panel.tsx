"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import {
  AlertTriangleIcon,
  BookIcon,
  PillIcon,
  ShieldIcon,
} from "@/components/icons";
import { DISCLAIMER } from "@/lib/constants";
import type { MedicineInfoPayload } from "@/lib/types";

type Status = "loading" | "ready" | "error";

/**
 * The "Info" tab health panel on /medicine/[id].
 *
 * Fetches POST /api/medicine-info (LLM-only for now; TinyFish live sources come
 * in Phase 3B). The LLM is sent only the medicine name and composition, never
 * personal data. Shows a loading skeleton, an error state with retry, an empty
 * state, and the required disclaimer at all times.
 */
export function MedicineInfoPanel({ medicineId }: { medicineId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [info, setInfo] = useState<MedicineInfoPayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lang, setLang] = useState<"en" | "hi">("en");
  const [showSimple, setShowSimple] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setMessage(null);

    try {
      const response = await fetch("/api/medicine-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medicine_id: medicineId }),
        cache: "no-store",
      });

      const payload = (await response.json().catch(() => null)) as
        | MedicineInfoPayload
        | { error?: string }
        | null;

      if (!response.ok || !payload || "error" in payload) {
        throw new Error(
          (payload && "error" in payload && payload.error) ||
            "We could not load the medicine info."
        );
      }

      setInfo(payload as MedicineInfoPayload);
      setStatus("ready");
    } catch (caught) {
      setMessage(
        caught instanceof Error
          ? caught.message
          : "Something went wrong. Please try again."
      );
      setStatus("error");
    }
  }, [medicineId]);

  useEffect(() => {
    // Scheduled (not called synchronously) so the effect body itself does not
    // trigger a cascading state update from `load`'s setStatus.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (status === "loading") {
    return <InfoSkeleton />;
  }

  if (status === "error") {
    return (
      <Card className="space-y-3">
        <SectionHeading icon={<BookIcon className="h-5 w-5" />} title="About this medicine" />
        <p className="text-[15px] text-red-700">
          {message ?? "We could not load the medicine info."}
        </p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
        <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
      </Card>
    );
  }

  if (!info || !hasContent(info)) {
    return (
      <Card className="space-y-2">
        <SectionHeading icon={<BookIcon className="h-5 w-5" />} title="About this medicine" />
        <p className="text-[15px] text-slate-500">
          We do not have general information for this medicine yet. Add the
          composition, or ask a pharmacist.
        </p>
        <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <SectionHeading icon={<BookIcon className="h-5 w-5" />} title="Uses" />
        <p className="text-[15px] leading-relaxed text-slate-700">{info.uses}</p>
      </Card>

      <Card className="space-y-3">
        <SectionHeading icon={<PillIcon className="h-5 w-5" />} title="Usual dosage" />
        <p className="text-[15px] leading-relaxed text-slate-700">
          {info.usual_dosage}
        </p>
      </Card>

      <Card className="space-y-3">
        <SectionHeading
          icon={<AlertTriangleIcon className="h-5 w-5" />}
          title="Side effects"
        />
        {info.common_side_effects.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-[15px] text-slate-700">
            {info.common_side_effects.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-slate-500">Not sure.</p>
        )}
      </Card>

      <Card className="space-y-3">
        <SectionHeading icon={<ShieldIcon className="h-5 w-5" />} title="Warnings" />
        <div className="space-y-3 text-[15px] text-slate-700">
          <WarningRow label="Do not take if">
            {info.warnings.when_not_to_take.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5">
                {info.warnings.when_not_to_take.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <span className="text-slate-500">Not sure.</span>
            )}
          </WarningRow>
          <WarningRow label="With food">
            {info.warnings.food_instruction || (
              <span className="text-slate-500">Not sure.</span>
            )}
          </WarningRow>
          <WarningRow label="Alcohol">
            {info.warnings.alcohol || (
              <span className="text-slate-500">Not sure.</span>
            )}
          </WarningRow>
          <WarningRow label="Pregnancy">
            {info.warnings.pregnancy_note || (
              <span className="text-slate-500">Not sure.</span>
            )}
          </WarningRow>
        </div>
      </Card>

      <Card className="space-y-3">
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => setShowSimple((value) => !value)}
        >
          Ye medicine kis liye hai?
        </Button>

        {showSimple && (
          <div className="space-y-3">
            <div className="flex justify-end gap-1">
              {(["en", "hi"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setLang(value)}
                  aria-pressed={lang === value}
                  className={`min-h-[36px] rounded-full px-3 text-[14px] font-semibold ${
                    lang === value
                      ? "bg-primary-600 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {value === "en" ? "English" : "हिंदी"}
                </button>
              ))}
            </div>
            <p className="text-[15px] leading-relaxed text-slate-700">
              {lang === "hi"
                ? info.simple_explanation_hi || info.simple_explanation
                : info.simple_explanation}
            </p>
          </div>
        )}
      </Card>

      <Card className="space-y-2">
        <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Sources
        </p>
        {info.sources.length > 0 ? (
          <ul className="space-y-1">
            {info.sources.map((source) => (
              <li key={source}>
                <a
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-[14px] font-semibold text-primary-700 underline"
                >
                  {source}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-slate-500">
            No live sources yet. This is general information only.
          </p>
        )}
        <p className="text-[14px] font-medium text-slate-600">
          {info.source_label}
        </p>
      </Card>

      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
    </div>
  );
}

function hasContent(info: MedicineInfoPayload): boolean {
  return Boolean(
    info.uses ||
      info.usual_dosage ||
      info.simple_explanation ||
      info.common_side_effects.length > 0 ||
      info.warnings.when_not_to_take.length > 0
  );
}

function SectionHeading({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-primary-600">{icon}</span>
      <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
        {title}
      </p>
    </div>
  );
}

function WarningRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[14px] font-semibold text-slate-500">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function InfoSkeleton() {
  return (
    <Card className="space-y-3">
      <p className="flex items-center gap-2 text-[15px] font-medium text-primary-700">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary-500" />
        Loading general information…
      </p>
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-2/3 rounded bg-slate-200" />
        <div className="h-4 w-1/2 rounded bg-slate-200" />
        <div className="h-4 w-3/4 rounded bg-slate-200" />
        <div className="h-4 w-1/3 rounded bg-slate-200" />
      </div>
      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
    </Card>
  );
}
