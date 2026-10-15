import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button, Card, PageHeader } from "@/components/ui";
import { VerifyStatus } from "@/components/medicine/verify-status";
import { DISCLAIMER, MEDICINE_IMAGES_BUCKET } from "@/lib/constants";

export const instant = false;

type RiskLevel = "green" | "amber" | "red";

type MedicineRow = {
  id: string;
  name: string;
  composition: string[] | null;
  batch_no: string | null;
  mfg_date: string | null;
  expiry_date: string | null;
  mrp: number | string | null;
  license_no: string | null;
  manufacturer: string | null;
  barcode: string | null;
  risk_level: RiskLevel | null;
  strip_image_path: string | null;
  box_image_path: string | null;
};

const MEDICINE_COLUMNS =
  "id, name, composition, batch_no, mfg_date, expiry_date, mrp, license_no, manufacturer, barcode, risk_level, strip_image_path, box_image_path";

const RISK_STYLES: Record<
  RiskLevel,
  { card: string; badge: string; label: string }
> = {
  green: {
    card: "border-emerald-200 bg-emerald-50",
    badge: "bg-emerald-200 text-emerald-900",
    label: "Low concern",
  },
  amber: {
    card: "border-amber-200 bg-amber-50",
    badge: "bg-amber-200 text-amber-900",
    label: "Check before use",
  },
  red: {
    card: "border-red-200 bg-red-50",
    badge: "bg-red-200 text-red-900",
    label: "High concern",
  },
};

function riskLevel(value: string | null): RiskLevel {
  return value === "green" || value === "red" ? value : "amber";
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatMoney(value: number | string | null): string | null {
  if (value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `₹ ${numeric.toFixed(2)}` : null;
}

/**
 * Placeholder trust card page. Phase 3 (lib/risk.ts) and Phase 3B
 * (/api/verify/start) are not built yet, so the verdict below is the amber
 * placeholder written by saveMedicine and the online check is still running.
 */
export default async function MedicinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireRole("patient");

  const supabase = await createClient();
  const { data } = await supabase
    .from("medicines")
    .select(MEDICINE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (!data) notFound();
  const medicine = data as MedicineRow;

  // Photos live in a private bucket; a short-lived signed URL is enough.
  const photoPath = medicine.strip_image_path ?? medicine.box_image_path;
  let photoUrl: string | null = null;
  if (photoPath) {
    const { data: signed } = await supabase.storage
      .from(MEDICINE_IMAGES_BUCKET)
      .createSignedUrl(photoPath, 60 * 60);
    photoUrl = signed?.signedUrl ?? null;
  }

  const level = riskLevel(medicine.risk_level);
  const style = RISK_STYLES[level];

  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null) => {
    if (value) rows.push({ label, value });
  };
  push("Composition", medicine.composition?.join(", ") || null);
  push("Batch no", medicine.batch_no);
  push("Mfg date", formatDate(medicine.mfg_date));
  push("Expiry date", formatDate(medicine.expiry_date));
  push("MRP", formatMoney(medicine.mrp));
  push("License no", medicine.license_no);
  push("Manufacturer", medicine.manufacturer);
  push("Barcode", medicine.barcode);

  return (
    <div className="space-y-4">
      <PageHeader title={medicine.name} subtitle="Trust card" />

      {/* TODO(Phase 3): replace this amber placeholder with the verdict from
          lib/risk.ts (risk_level + risk_reasons) once the rules engine ships. */}
      <Card className={`space-y-3 ${style.card}`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-600 uppercase">
              Risk check pending
            </p>
            <p className="text-xl font-bold text-slate-900">{style.label}</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-[13px] font-bold uppercase ${style.badge}`}
          >
            {level}
          </span>
        </div>

        <p className="text-[15px] text-slate-700">
          The deterministic rules engine is not wired up yet, so this is a
          placeholder verdict. Do not treat it as a real result.
        </p>

        <VerifyStatus medicineId={medicine.id} />

        <p className="text-xs leading-snug text-slate-500">{DISCLAIMER}</p>
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Printed details
        </p>
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
          <p className="text-[15px] text-slate-500">No extra details saved.</p>
        )}
      </Card>

      {photoUrl && (
        <Card className="space-y-2">
          <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Photo
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl}
            alt={`Photo of ${medicine.name}`}
            className="max-h-72 w-full rounded-xl border border-slate-200 object-contain"
          />
        </Card>
      )}

      <div className="space-y-2">
        {/* TODO(Phase 4): "Set a reminder" flow. */}
        <Link href="/cabinet" className="block">
          <Button variant="secondary" className="w-full">
            Back to cabinet
          </Button>
        </Link>
        <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
      </div>
    </div>
  );
}
