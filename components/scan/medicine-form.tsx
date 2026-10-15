"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveMedicine } from "@/app/(app)/scan/medicine-actions";
import { Button, Card, Input } from "@/components/ui";
import { PhotoZoom } from "@/components/scan/photo-zoom";
import { clearReviewPayload } from "@/lib/review";
import { needsVerification, type MedicineInput } from "@/lib/medicine";
import { DISCLAIMER } from "@/lib/constants";
import type { MedicineExtraction, ScanMode } from "@/lib/extraction";

type Props = {
  /** Extracted data on /scan/review, EMPTY_EXTRACTION on /scan/manual. */
  initial: MedicineExtraction;
  /** Storage paths of the uploaded photos (none on /scan/manual). */
  imagePaths: string[];
  mode: ScanMode;
  source: "scan" | "manual";
};

function compositionLabel(item: {
  ingredient: string;
  strength: string | null;
}): string {
  return item.strength ? `${item.ingredient} (${item.strength})` : item.ingredient;
}

function parseMrp(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

/**
 * Editable medicine form used by both /scan/review (prefilled from the vision
 * LLM, low-confidence fields flagged) and /scan/manual (blank).
 */
export function MedicineForm({ initial, imagePaths, mode, source }: Props) {
  const router = useRouter();
  const confidence = initial.confidence ?? {};
  const needsVerify = (field: string) => needsVerification(confidence, field);

  const [name, setName] = useState(initial.name ?? initial.brand ?? "");
  const [composition, setComposition] = useState<string[]>(() =>
    initial.composition.map(compositionLabel)
  );
  const [draft, setDraft] = useState("");
  const [batchNo, setBatchNo] = useState(initial.batch_no ?? "");
  const [mfgDate, setMfgDate] = useState(initial.mfg_date ?? "");
  const [expiryDate, setExpiryDate] = useState(initial.expiry_date ?? "");
  const [mrp, setMrp] = useState(initial.mrp === null ? "" : String(initial.mrp));
  const [licenseNo, setLicenseNo] = useState(initial.license_no ?? "");
  const [manufacturer, setManufacturer] = useState(initial.manufacturer ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function addIngredient() {
    const value = draft.trim();
    if (!value) return;
    if (!composition.some((item) => item.toLowerCase() === value.toLowerCase())) {
      setComposition([...composition, value]);
    }
    setDraft("");
  }

  function removeIngredient(item: string) {
    setComposition(composition.filter((existing) => existing !== item));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Please enter the medicine name.");
      return;
    }

    setSaving(true);
    setError(null);

    const input: MedicineInput = {
      name: trimmedName,
      composition: composition.map((item) => item.trim()).filter(Boolean),
      batch_no: batchNo.trim() || null,
      mfg_date: mfgDate || null,
      expiry_date: expiryDate || null,
      mrp: parseMrp(mrp),
      license_no: licenseNo.trim() || null,
      manufacturer: manufacturer.trim() || null,
      barcode_text: initial.barcode_text,
      storage_notes: initial.storage_notes,
      strip_image_path: imagePaths[0] ?? null,
      box_image_path: imagePaths[1] ?? null,
      mode,
      source,
      confidence,
    };

    try {
      const result = await saveMedicine(input);

      if (!result.ok) {
        setError(result.error);
        setSaving(false);
        return;
      }

      // The reviewed extraction is stored in the database now.
      clearReviewPayload();

      // TODO(Phase 3B): /api/verify/start does not exist yet, so this request
      // is expected to 404. It is deliberately fire-and-forget: we never await
      // it and swallow every failure, because saving must succeed even when
      // the online check cannot be started. The trust card shows
      // "Online check running…" until the route ships.
      void fetch("/api/verify/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medicine_id: result.id }),
        keepalive: true,
      }).catch(() => undefined);

      router.push(`/medicine/${result.id}`);
    } catch {
      setError("Could not save the medicine. Check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {source === "scan" ? (
        <Card className="space-y-1 border-amber-200 bg-amber-50">
          <p className="text-[15px] font-medium text-amber-900">
            Check every field against your photo.
          </p>
          <p className="text-[15px] text-amber-800">
            Fields marked “Please verify” were unclear or read with low
            confidence.
          </p>
        </Card>
      ) : (
        <Card className="space-y-1">
          <p className="text-[15px] text-slate-600">
            Type the details printed on the strip or box. Only the name is
            required, but more detail means a better risk check later.
          </p>
        </Card>
      )}

      <PhotoZoom paths={imagePaths} />

      <Card className="space-y-4">
        <FormField label="Medicine name" flag={needsVerify("name")}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Paracetamol 500 mg"
            autoComplete="off"
            tone={needsVerify("name") ? "verify" : "default"}
          />
        </FormField>

        <FormField
          label="Composition"
          flag={needsVerify("composition")}
          hint="Add each active ingredient. Press Enter or tap Add."
        >
          <div className="space-y-2">
            {composition.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {composition.map((item) => (
                  <span
                    key={item}
                    className={`inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1 text-[15px] font-medium ${
                      needsVerify("composition")
                        ? "bg-amber-100 text-amber-900"
                        : "bg-primary-100 text-primary-800"
                    }`}
                  >
                    {item}
                    <button
                      type="button"
                      onClick={() => removeIngredient(item)}
                      aria-label={`Remove ${item}`}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-lg leading-none hover:bg-black/5"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    addIngredient();
                  }
                }}
                placeholder="e.g. Paracetamol 500 mg"
                autoComplete="off"
                tone={needsVerify("composition") ? "verify" : "default"}
              />
              <Button type="button" variant="secondary" onClick={addIngredient}>
                Add
              </Button>
            </div>
          </div>
        </FormField>

        <FormField label="Batch number" flag={needsVerify("batch_no")}>
          <Input
            value={batchNo}
            onChange={(event) => setBatchNo(event.target.value)}
            autoComplete="off"
            tone={needsVerify("batch_no") ? "verify" : "default"}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Mfg date" flag={needsVerify("mfg_date")}>
            <Input
              type="date"
              value={mfgDate}
              onChange={(event) => setMfgDate(event.target.value)}
              tone={needsVerify("mfg_date") ? "verify" : "default"}
            />
          </FormField>
          <FormField label="Expiry date" flag={needsVerify("expiry_date")}>
            <Input
              type="date"
              value={expiryDate}
              onChange={(event) => setExpiryDate(event.target.value)}
              tone={needsVerify("expiry_date") ? "verify" : "default"}
            />
          </FormField>
        </div>

        <FormField label="MRP" flag={needsVerify("mrp")}>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={mrp}
            onChange={(event) => setMrp(event.target.value)}
            placeholder="e.g. 45.50"
            tone={needsVerify("mrp") ? "verify" : "default"}
          />
        </FormField>
      </Card>

      <Card className="space-y-4">
        <FormField label="License number" flag={needsVerify("license_no")}>
          <Input
            value={licenseNo}
            onChange={(event) => setLicenseNo(event.target.value)}
            autoComplete="off"
            tone={needsVerify("license_no") ? "verify" : "default"}
          />
        </FormField>

        <FormField label="Manufacturer" flag={needsVerify("manufacturer")}>
          <Input
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
            autoComplete="off"
            tone={needsVerify("manufacturer") ? "verify" : "default"}
          />
        </FormField>
      </Card>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700"
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Button type="submit" className="w-full" disabled={saving}>
          {saving ? "Saving…" : "Save & check"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={saving}
          onClick={() => router.push("/scan")}
        >
          Back to scan
        </Button>
      </div>

      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
    </form>
  );
}

function FormField({
  label,
  flag,
  hint,
  children,
}: {
  label: string;
  flag: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[15px] font-medium text-slate-700">{label}</span>
        {flag && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold tracking-wide text-amber-800 uppercase">
            Please verify
          </span>
        )}
      </span>
      {children}
      {hint && <span className="mt-1 block text-sm text-slate-400">{hint}</span>}
    </label>
  );
}
