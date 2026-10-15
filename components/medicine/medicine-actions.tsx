"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { compressImage } from "@/lib/image";
import { MEDICINE_IMAGES_BUCKET } from "@/lib/constants";
import { Button, Input } from "@/components/ui";
import { BellIcon } from "@/components/icons";
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
  hasStripImage: boolean;
  hasBoxImage: boolean;
  /** Ask the trust card to recompute after the data changed. */
  onChanged: () => void;
};

export function MedicineActions({
  medicineId,
  userId,
  reminderTimes,
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
          onClose={() => setOpen(null)}
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

function ReminderSheet({
  medicineId,
  times,
  onClose,
}: {
  medicineId: string;
  times: { label: string; time: string }[];
  onClose: () => void;
}) {
  // Collapse duplicate times (patient may share a meal time).
  const options = useMemo(() => {
    const seen = new Set<string>();
    return times.filter((item) =>
      seen.has(item.time) ? false : (seen.add(item.time), true)
    );
  }, [times]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(time: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(time)) next.delete(time);
      else next.add(time);
      return next;
    });
  }

  async function submit() {
    if (busy) return;
    if (selected.size === 0) {
      setError("Pick at least one time for the reminder.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createReminder(medicineId, [...selected].sort());
    setBusy(false);
    if (result.ok) {
      setSuccess(result.message);
      window.setTimeout(onClose, 1200);
    } else {
      setError(result.error);
    }
  }

  return (
    <Sheet title="Set a daily reminder" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[15px] text-slate-600">
          We will remind you to take this medicine at the times you pick.
        </p>
        <div className="space-y-2">
          {options.map((item) => {
            const active = selected.has(item.time);
            return (
              <button
                key={item.time}
                type="button"
                onClick={() => toggle(item.time)}
                aria-pressed={active}
                className={`flex min-h-[56px] w-full items-center justify-between rounded-xl border px-4 text-left text-[17px] font-semibold transition-colors ${
                  active
                    ? "border-primary-500 bg-primary-50 text-primary-800"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                <span>{item.label}</span>
                <span className="text-[15px] font-medium text-slate-500">
                  {item.time}
                </span>
              </button>
            );
          })}
        </div>
        <SheetMessage error={error} success={success} />
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || success !== null}>
            {busy ? "Saving…" : "Set reminder"}
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
