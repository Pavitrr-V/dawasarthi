"use client";

import { useState } from "react";
import { Button, Card, Field, Input } from "@/components/ui";
import type { MedicineExtraction } from "@/lib/extraction";

type FieldKey =
  | "name"
  | "brand"
  | "composition"
  | "batch_no"
  | "mfg_date"
  | "expiry_date"
  | "mrp"
  | "license_no"
  | "manufacturer"
  | "barcode_text"
  | "storage_notes";

const EMPTY: Record<FieldKey, string> = {
  name: "",
  brand: "",
  composition: "",
  batch_no: "",
  mfg_date: "",
  expiry_date: "",
  mrp: "",
  license_no: "",
  manufacturer: "",
  barcode_text: "",
  storage_notes: "",
};

export function ManualEntryForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (extraction: MedicineExtraction) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<FieldKey, string>>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  function update(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function text(key: FieldKey): string | null {
    const value = values[key].trim();
    return value.length > 0 ? value : null;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!values.name.trim()) {
      setError("Please enter the medicine name.");
      return;
    }
    setError(null);

    const mrpText = values.mrp.trim();
    const mrp = mrpText === "" ? null : Number(mrpText.replace(/[^0-9.]/g, ""));
    const hasMonthPrecision =
      values.mfg_date.trim().endsWith("-01") ||
      values.expiry_date.trim().endsWith("-01");

    onSubmit({
      name: text("name"),
      brand: text("brand"),
      composition: values.composition
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((ingredient) => ({ ingredient, strength: null })),
      batch_no: text("batch_no"),
      mfg_date: text("mfg_date"),
      expiry_date: text("expiry_date"),
      mrp: Number.isFinite(mrp) ? Math.max(0, mrp as number) : null,
      license_no: text("license_no"),
      manufacturer: text("manufacturer"),
      barcode_text: text("barcode_text"),
      storage_notes: text("storage_notes"),
      date_precision: hasMonthPrecision ? "month" : "day",
      confidence: {},
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card className="space-y-4">
        <Field label="Medicine name">
          <Input
            value={values.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Paracetamol 500 mg"
            required
          />
        </Field>
        <Field label="Brand">
          <Input
            value={values.brand}
            onChange={(e) => update("brand", e.target.value)}
            placeholder="e.g. Crocin"
          />
        </Field>
        <Field
          label="Ingredients"
          hint="Separate ingredients with commas."
        >
          <Input
            value={values.composition}
            onChange={(e) => update("composition", e.target.value)}
            placeholder="e.g. Paracetamol, Caffeine"
          />
        </Field>
      </Card>

      <Card className="space-y-4">
        <Field label="Batch number">
          <Input
            value={values.batch_no}
            onChange={(e) => update("batch_no", e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mfg date">
            <Input
              type="date"
              value={values.mfg_date}
              onChange={(e) => update("mfg_date", e.target.value)}
            />
          </Field>
          <Field label="Expiry date">
            <Input
              type="date"
              value={values.expiry_date}
              onChange={(e) => update("expiry_date", e.target.value)}
            />
          </Field>
        </div>
        <Field label="MRP">
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={values.mrp}
            onChange={(e) => update("mrp", e.target.value)}
            placeholder="e.g. 45.50"
          />
        </Field>
      </Card>

      <Card className="space-y-4">
        <Field label="Manufacturer">
          <Input
            value={values.manufacturer}
            onChange={(e) => update("manufacturer", e.target.value)}
          />
        </Field>
        <Field label="License number">
          <Input
            value={values.license_no}
            onChange={(e) => update("license_no", e.target.value)}
          />
        </Field>
        <Field label="Barcode text">
          <Input
            value={values.barcode_text}
            onChange={(e) => update("barcode_text", e.target.value)}
          />
        </Field>
        <Field label="Storage notes">
          <Input
            value={values.storage_notes}
            onChange={(e) => update("storage_notes", e.target.value)}
            placeholder="e.g. Store below 30°C"
          />
        </Field>
      </Card>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Button type="submit" className="w-full">
          Use these details
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={onCancel}
        >
          Back to scan
        </Button>
      </div>
    </form>
  );
}
