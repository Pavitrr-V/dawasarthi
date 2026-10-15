import { Card } from "@/components/ui";
import type { MedicineExtraction } from "@/lib/extraction";

function formatMoney(value: number): string {
  return `₹ ${value.toFixed(2)}`;
}

export function ResultCard({
  title = "Extracted",
  data,
}: {
  title?: string;
  data: MedicineExtraction | null;
}) {
  if (!data) {
    return (
      <Card className="border-amber-200 bg-amber-50">
        <p className="text-[15px] font-medium text-amber-800">{title}</p>
        <p className="mt-1 text-[15px] text-amber-700">
          We could not read this image.
        </p>
      </Card>
    );
  }

  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null) => {
    if (value) rows.push({ label, value });
  };

  push("Brand", data.brand);
  push(
    "Composition",
    data.composition
      .map((item) =>
        item.strength ? `${item.ingredient} (${item.strength})` : item.ingredient
      )
      .join(", ") || null
  );
  push("Batch no", data.batch_no);
  push("Mfg date", data.mfg_date);
  push("Expiry date", data.expiry_date);
  push("MRP", data.mrp !== null ? formatMoney(data.mrp) : null);
  push("Manufacturer", data.manufacturer);
  push("License no", data.license_no);
  push("Barcode", data.barcode_text);
  push("Storage", data.storage_notes);

  const confidenceValues = Object.values(data.confidence);
  const lowest =
    confidenceValues.length > 0 ? Math.min(...confidenceValues) : null;

  return (
    <Card className="space-y-4">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-primary-600">
          {title}
        </p>
        <h2 className="mt-0.5 text-xl font-bold text-slate-900">
          {data.name ?? "Unknown medicine"}
        </h2>
        {data.date_precision === "month" && (
          <p className="mt-0.5 text-sm text-slate-400">
            Dates shown are month-level (first of month).
          </p>
        )}
      </div>

      {rows.length > 0 ? (
        <dl className="divide-y divide-slate-100">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4 py-2">
              <dt className="text-[15px] text-slate-500">{row.label}</dt>
              <dd className="max-w-[60%] text-right text-[15px] font-medium text-slate-900">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[15px] text-slate-500">
          No printed fields were readable.
        </p>
      )}

      {lowest !== null && (
        <p className="text-sm text-slate-400">
          Lowest field confidence: {Math.round(lowest * 100)}%
        </p>
      )}
    </Card>
  );
}
