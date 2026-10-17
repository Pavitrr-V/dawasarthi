"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { compressImage } from "@/lib/image";
import { MEDICINE_IMAGES_BUCKET } from "@/lib/constants";
import { Button, Input } from "@/components/ui";
import { BellIcon } from "@/components/icons";
import {
  MAX_DURATION_DAYS,
  MEAL_LINKS,
  WEEKDAY_NAMES,
  mealLinkLabel,
  normalizeTimes,
  resolveMealTime,
  type DaysPattern,
  type MealLink,
} from "@/lib/schedule";
import {
  addToCabinet,
  attachSidePhoto,
  createReminder,
  reportSuspiciousMedicine,
} from "@/app/(app)/medicine/[id]/actions";

type SheetKind = "reminder" | "cabinet" | "report" | "side" | null;

export type MedicineActionsProps = {
  medicineId: string;
  userId: string;
  reminderTimes: { label: string; time: string }[];
  /** Today in Asia/Kolkata ("YYYY-MM-DD") — used to default the start date. */
  todayIst: string;
  hasStripImage: boolean;
  hasBoxImage: boolean;
  /** Ask the trust card to recompute after the data changed. */
  onChanged: () => void;
};

export function MedicineActions({
  medicineId,
  userId,
  reminderTimes,
  todayIst,
  hasStripImage,
  hasBoxImage,
  onChanged,
}: MedicineActionsProps) {
  const [open, setOpen] = useState<SheetKind>(null);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" onClick={() => setOpen("reminder")}>
          <BellIcon className="mr-1.5 h-5 w-5" />
          Set reminder
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen("cabinet")}
        >
          Add to cabinet
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen("report")}
        >
          Report suspicious
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen("side")}>
          Scan other side
        </Button>
      </div>

      {open === "reminder" && (
        <ReminderSheet
          medicineId={medicineId}
          times={reminderTimes}
          todayIst={todayIst}
          onClose={() => setOpen(null)}
          onChanged={onChanged}
        />
      )}
      {open === "cabinet" && (
        <CabinetSheet
          medicineId={medicineId}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "report" && (
        <ReportSheet medicineId={medicineId} onClose={() => setOpen(null)} />
      )}
      {open === "side" && (
        <SideSheet
          medicineId={medicineId}
          userId={userId}
          hasStripImage={hasStripImage}
          hasBoxImage={hasBoxImage}
          onClose={() => setOpen(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet shell
// ---------------------------------------------------------------------------

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-t-2xl bg-white p-4 pb-8 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full text-2xl leading-none text-slate-500 hover:bg-slate-100"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SheetMessage({
  error,
  success,
}: {
  error: string | null;
  success: string | null;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[15px] text-red-700"
      >
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[15px] text-emerald-800">
        {success}
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Set reminder
// ---------------------------------------------------------------------------

const PATTERN_OPTIONS: { value: DaysPattern; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "alternate", label: "Alternate days" },
  { value: "weekdays", label: "Specific days" },
  { value: "as_needed", label: "As needed" },
];

function ReminderSheet({
  medicineId,
  times,
  todayIst,
  onClose,
  onChanged,
}: {
  medicineId: string;
  times: { label: string; time: string }[];
  todayIst: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();

  // The profile's meal times, used both as quick-pick chips and to resolve a
  // "before/after meal" link locally so the user sees the resulting clock time.
  const mealTimes = useMemo(() => {
    const find = (name: string) =>
      times.find((item) => item.label.toLowerCase().startsWith(name))?.time ?? null;
    return {
      breakfast: find("breakfast"),
      lunch: find("lunch"),
      dinner: find("dinner"),
    };
  }, [times]);

  const [chosen, setChosen] = useState<string[]>([]);
  const [customTime, setCustomTime] = useState("09:00");
  const [pattern, setPattern] = useState<DaysPattern>("daily");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [mealLink, setMealLink] = useState<MealLink | "">("");
  const [startDate, setStartDate] = useState(todayIst);
  const [ongoing, setOngoing] = useState(true);
  const [duration, setDuration] = useState("5");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mealPreview =
    mealLink === "" ? null : resolveMealTime(mealLink, mealTimes);
  const effectiveTimes = normalizeTimes([
    ...chosen,
    ...(mealPreview ? [mealPreview] : []),
  ]);

  function toggleTime(time: string) {
    setChosen((current) =>
      current.includes(time)
        ? current.filter((item) => item !== time)
        : [...current, time]
    );
  }

  function addCustom() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(customTime)) {
      setError("Enter a valid time.");
      return;
    }
    setError(null);
    setChosen((current) =>
      current.includes(customTime) ? current : [...current, customTime]
    );
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day].sort((a, b) => a - b)
    );
  }

  async function submit() {
    if (busy) return;

    const durationDays = ongoing ? null : Number(duration);
    if (
      effectiveTimes.length === 0 &&
      pattern !== "as_needed"
    ) {
      setError("Pick at least one time for the reminder.");
      return;
    }
    if (pattern === "weekdays" && weekdays.length === 0) {
      setError("Pick at least one day of the week.");
      return;
    }
    if (
      !ongoing &&
      (!Number.isInteger(durationDays) ||
        (durationDays ?? 0) < 1 ||
        (durationDays ?? 0) > MAX_DURATION_DAYS)
    ) {
      setError(`Enter a course length between 1 and ${MAX_DURATION_DAYS} days.`);
      return;
    }

    setBusy(true);
    setError(null);
    const result = await createReminder({
      medicineId,
      times: chosen,
      daysPattern: pattern,
      weekdays: pattern === "weekdays" ? weekdays : [],
      mealLink: mealLink === "" ? null : mealLink,
      startDate,
      durationDays,
    });
    setBusy(false);

    if (result.ok) {
      setSuccess(result.message);
      onChanged();
      router.refresh();
      window.setTimeout(onClose, 1200);
    } else {
      setError(result.error);
    }
  }

  const quickPicks = useMemo(() => {
    const seen = new Set<string>();
    return times.filter((item) =>
      seen.has(item.time) ? false : (seen.add(item.time), true)
    );
  }, [times]);

  return (
    <Sheet title="Set a reminder" onClose={onClose}>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        {/* Times */}
        <section className="space-y-2">
          <p className="text-[15px] font-semibold text-slate-700">
            When should we remind you?
          </p>
          <div className="flex flex-wrap gap-2">
            {quickPicks.map((item) => {
              const active = chosen.includes(item.time);
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => toggleTime(item.time)}
                  aria-pressed={active}
                  className={`min-h-[44px] rounded-full border px-3 text-[15px] font-semibold transition-colors ${
                    active
                      ? "border-primary-500 bg-primary-50 text-primary-800"
                      : "border-slate-300 bg-white text-slate-700"
                  }`}
                >
                  {item.label} · {item.time}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={customTime}
              step={300}
              onChange={(event) => setCustomTime(event.target.value)}
              aria-label="Add a time"
              className="flex-1"
            />
            <Button type="button" variant="secondary" onClick={addCustom}>
              Add time
            </Button>
          </div>

          {chosen.length > 0 && (
            <p className="text-[14px] text-slate-500">
              Chosen: {normalizeTimes(chosen).join(", ")}
            </p>
          )}
        </section>

        {/* Meal link */}
        <section className="space-y-2">
          <label className="block text-[15px] font-semibold text-slate-700">
            Link to a meal (optional)
          </label>
          <select
            value={mealLink}
            onChange={(event) => setMealLink(event.target.value as MealLink | "")}
            className="min-h-[52px] w-full rounded-xl border border-slate-300 bg-white px-4 text-[17px] text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
          >
            <option value="">No meal link</option>
            {MEAL_LINKS.map((link) => (
              <option key={link} value={link}>
                {mealLinkLabel(link)}
              </option>
            ))}
          </select>
          {mealPreview && (
            <p className="text-[14px] text-slate-500">
              We will use {mealPreview} (your meal time ± 30 minutes).
            </p>
          )}
        </section>

        {/* Days pattern */}
        <section className="space-y-2">
          <p className="text-[15px] font-semibold text-slate-700">How often?</p>
          <div className="grid grid-cols-2 gap-2">
            {PATTERN_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPattern(option.value)}
                aria-pressed={pattern === option.value}
                className={`min-h-[48px] rounded-xl border text-[15px] font-semibold ${
                  pattern === option.value
                    ? "border-primary-500 bg-primary-50 text-primary-800"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {pattern === "weekdays" && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {WEEKDAY_NAMES.map((name, day) => {
                const active = weekdays.includes(day);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    aria-pressed={active}
                    className={`h-11 w-11 rounded-full border text-[15px] font-semibold ${
                      active
                        ? "border-primary-500 bg-primary-50 text-primary-800"
                        : "border-slate-300 bg-white text-slate-600"
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Course */}
        <section className="space-y-2">
          <p className="text-[15px] font-semibold text-slate-700">For how long?</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOngoing(true)}
              aria-pressed={ongoing}
              className={`min-h-[48px] flex-1 rounded-xl border text-[15px] font-semibold ${
                ongoing
                  ? "border-primary-500 bg-primary-50 text-primary-800"
                  : "border-slate-300 bg-white text-slate-700"
              }`}
            >
              Ongoing
            </button>
            <button
              type="button"
              onClick={() => setOngoing(false)}
              aria-pressed={!ongoing}
              className={`min-h-[48px] flex-1 rounded-xl border text-[15px] font-semibold ${
                !ongoing
                  ? "border-primary-500 bg-primary-50 text-primary-800"
                  : "border-slate-300 bg-white text-slate-700"
              }`}
            >
              A fixed course
            </button>
          </div>
          {!ongoing && (
            <label className="flex items-center gap-2 text-[15px] text-slate-600">
              Number of days
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_DURATION_DAYS}
                step={1}
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                aria-label="Course length in days"
                className="w-24"
              />
            </label>
          )}
        </section>

        {/* Start date */}
        <section className="space-y-2">
          <label className="block text-[15px] font-semibold text-slate-700">
            Start date
          </label>
          <Input
            type="date"
            value={startDate}
            min={todayIst}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </section>

        <SheetMessage error={error} success={success} />

        <div className="grid grid-cols-2 gap-2 pb-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || success !== null}>
            {busy ? "Saving…" : "Confirm reminder"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Add to cabinet
// ---------------------------------------------------------------------------

function CabinetSheet({
  medicineId,
  onClose,
}: {
  medicineId: string;
  onClose: () => void;
}) {
  const [quantity, setQuantity] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    const parsed = Number(quantity);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setError("Enter a whole number of tablets.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await addToCabinet(medicineId, parsed);
    setBusy(false);
    if (result.ok) {
      setSuccess(result.message);
      window.setTimeout(onClose, 1200);
    } else {
      setError(result.error);
    }
  }

  return (
    <Sheet title="Add to cabinet" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          How many tablets do you have right now? We will track your stock.
        </p>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          aria-label="Tablet count"
        />
        <SheetMessage error={error} success={success} />
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || success !== null}>
            {busy ? "Saving…" : "Save stock"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Report suspicious medicine
// ---------------------------------------------------------------------------

function ReportSheet({
  medicineId,
  onClose,
}: {
  medicineId: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await reportSuspiciousMedicine(medicineId, note);
    setBusy(false);
    if (result.ok) {
      setSuccess(result.message);
      window.setTimeout(onClose, 1400);
    } else {
      setError(result.error);
    }
  }

  return (
    <Sheet title="Report suspicious medicine" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          Tell us what looks wrong (for example a broken seal, a strange
          colour, or a batch that looks fake). Your report is private.
        </p>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, 500))}
          rows={4}
          placeholder="What looks wrong?"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-[16px] text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
        />
        <SheetMessage error={error} success={success} />
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || success !== null}>
            {busy ? "Sending…" : "Send report"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Scan other side
// ---------------------------------------------------------------------------

type ExtractionLike = {
  name?: string | null;
  batch_no?: string | null;
  expiry_date?: string | null;
};

function SideSheet({
  medicineId,
  userId,
  hasStripImage,
  hasBoxImage,
  onClose,
  onChanged,
}: {
  medicineId: string;
  userId: string;
  hasStripImage: boolean;
  hasBoxImage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [side, setSide] = useState<"strip" | "box">(
    hasBoxImage && !hasStripImage ? "strip" : "box"
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      const supabase = createClient();
      const blob = await compressImage(file);
      const path = `${userId}/${crypto.randomUUID()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(MEDICINE_IMAGES_BUCKET)
        .upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (uploadError) {
        throw new Error("We could not upload that photo. Please try again.");
      }

      // Best-effort read of the other side; if the scanner is unavailable we
      // still attach the photo and recompute with what we have.
      let fields: ExtractionLike | null = null;
      try {
        const response = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "medicine", paths: [path] }),
        });
        if (response.ok) {
          const payload = (await response.json()) as ExtractionLike | null;
          if (payload) fields = payload;
        }
      } catch {
        fields = null;
      }

      const result = await attachSidePhoto(medicineId, side, path, fields);
      if (!result.ok) {
        setError(result.error);
        setBusy(false);
        return;
      }

      setSuccess(
        "Photo added. Re-running the risk check…"
      );
      onChanged();
      router.refresh();
      window.setTimeout(onClose, 1400);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Something went wrong. Please try again."
      );
      setBusy(false);
    }
  }

  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    if (chosen) void handleFile(chosen);
    event.target.value = "";
  }

  return (
    <Sheet title="Scan the other side" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          Take a photo of the other face of the strip or box. We will read it
          and check again.
        </p>

        <div className="grid grid-cols-2 gap-2">
          {(["strip", "box"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSide(value)}
              aria-pressed={side === value}
              className={`min-h-[52px] rounded-xl border text-[16px] font-semibold capitalize ${
                side === value
                  ? "border-primary-500 bg-primary-50 text-primary-800"
                  : "border-slate-300 bg-white text-slate-600"
              }`}
            >
              {value === "strip" ? "Front / Strip" : "Back / Box"}
              {(value === "strip" ? hasStripImage : hasBoxImage) ? " ✓" : ""}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            onClick={() => cameraRef.current?.click()}
            disabled={busy}
          >
            Camera
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => galleryRef.current?.click()}
            disabled={busy}
          >
            Gallery
          </Button>
        </div>

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={pick}
          className="hidden"
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          onChange={pick}
          className="hidden"
        />

        <SheetMessage error={error} success={success} />

        {busy && (
          <p className="flex items-center gap-2 text-[15px] font-medium text-primary-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary-500" />
            Uploading and reading the photo…
          </p>
        )}

        <Button type="button" variant="secondary" className="w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </Sheet>
  );
}
