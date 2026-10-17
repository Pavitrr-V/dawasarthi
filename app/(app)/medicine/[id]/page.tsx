import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOwnedPatient } from "@/lib/patients";
import { evaluateRisk, daysToExpiry } from "@/lib/risk";
import { buildRiskContext, MEDICINE_RISK_COLUMNS, type MedicineRiskRow } from "@/lib/risk-data";
import { Card, PageHeader } from "@/components/ui";
import { TrustCard } from "@/components/medicine/trust-card";
import { MedicineInfoPanel } from "@/components/medicine/medicine-info-panel";
import {
  ScheduleList,
  type ScheduleCardRow,
} from "@/components/medicine/schedule-list";
import { MEDICINE_IMAGES_BUCKET } from "@/lib/constants";
import { istToday } from "@/lib/schedule";

export const instant = false;

type InteractionPair = {
  ingredient_a: string;
  ingredient_b: string;
  severity: string;
  note: string | null;
};

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

/** "08:00:00" -> "08:00" for the reminder sheet's <input>/chip labels. */
function toHHMM(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : null;
}

/** "Paracetamol (500mg)" -> "paracetamol", for matching interaction pairs. */
function ingredientKey(value: string): string {
  return value.toLowerCase().replace(/\(.*?\)/g, "").trim();
}

function severityTone(severity: string): string {
  const value = severity.toLowerCase();
  if (value === "major" || value === "severe" || value === "high") {
    return "bg-red-100 text-red-800";
  }
  if (value === "moderate" || value === "medium") {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-600";
}

/**
 * Trust card page.
 *
 * The verdict shown is computed on the server by the deterministic
 * `evaluateRisk` engine from the stored medicine fields plus the latest
 * online-check signals, then kept fresh on the client through Realtime and
 * POST /api/risk/recompute.
 */
export default async function MedicinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole("patient");

  const supabase = await createClient();
  const { data } = await supabase
    .from("medicines")
    .select(MEDICINE_RISK_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (!data) notFound();
  const medicine = data as unknown as MedicineRiskRow;

  // Community report counts need the service role (RLS hides other users'
  // reports). Without the key we simply show 0 rather than failing.
  let admin = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  const [context, patient, schedulesResult] = await Promise.all([
    buildRiskContext({ supabase, medicine, admin }),
    getOwnedPatient(medicine.patient_id),
    supabase
      .from("schedules")
      .select(
        "id, times, days_pattern, weekdays, meal_link, start_date, duration_days"
      )
      .eq("medicine_id", medicine.id)
      .eq("active", true)
      .order("created_at", { ascending: false }),
  ]);

  const schedules = (schedulesResult.data ?? []) as ScheduleCardRow[];

  const result = evaluateRisk(context.input);
  const expiresInDays = daysToExpiry(medicine.expiry_date, context.input.today);

  // Signed URLs for the private photo bucket.
  const photoPaths = [
    { label: "Front / strip", path: medicine.strip_image_path },
    { label: "Back / box", path: medicine.box_image_path },
  ].filter((item): item is { label: string; path: string } => Boolean(item.path));

  const photos: { label: string; url: string }[] = [];
  for (const item of photoPaths) {
    const { data: signed } = await supabase.storage
      .from(MEDICINE_IMAGES_BUCKET)
      .createSignedUrl(item.path, 60 * 60);
    if (signed?.signedUrl) photos.push({ label: item.label, url: signed.signedUrl });
  }

  // Interaction warnings: a pair matters only when BOTH ingredients are in
  // this medicine's composition.
  const compositionKeys = new Set(
    (medicine.composition ?? []).map(ingredientKey).filter(Boolean)
  );
  let interactions: InteractionPair[] = [];
  if (compositionKeys.size > 0) {
    const { data: pairs } = await supabase
      .from("interaction_pairs")
      .select("ingredient_a, ingredient_b, severity, note");
    interactions = ((pairs ?? []) as InteractionPair[]).filter(
      (pair) =>
        compositionKeys.has(ingredientKey(pair.ingredient_a)) &&
        compositionKeys.has(ingredientKey(pair.ingredient_b))
    );
  }

  const mealTimes = [
    { label: "Breakfast", time: toHHMM(patient?.breakfast_time ?? null) ?? "08:00" },
    { label: "Lunch", time: toHHMM(patient?.lunch_time ?? null) ?? "14:00" },
    { label: "Dinner", time: toHHMM(patient?.dinner_time ?? null) ?? "21:00" },
  ];

  const detailRows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null) => {
    if (value) detailRows.push({ label, value });
  };
  push("Composition", medicine.composition?.join(", ") || null);
  push("Batch no", medicine.batch_no);
  push("Mfg date", formatDate(medicine.mfg_date));
  push("Expiry date", formatDate(medicine.expiry_date));
  push("MRP", formatMoney(medicine.mrp));
  push("License no", medicine.license_no);
  push("Manufacturer", medicine.manufacturer);
  push("Barcode", medicine.barcode);

  const infoPanel = (
    <div className="space-y-4">
      <MedicineInfoPanel medicineId={medicine.id} />

      <Card className="space-y-3">
        <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Printed details
        </p>
        {detailRows.length > 0 ? (
          <dl className="divide-y divide-slate-100">
            {detailRows.map((row) => (
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

      {photos.length > 0 && (
        <Card className="space-y-3">
          <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Photos
          </p>
          {photos.map((photo) => (
            <div key={photo.label} className="space-y-1">
              <p className="text-[14px] font-medium text-slate-500">
                {photo.label}
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.url}
                alt={`${photo.label} photo of ${medicine.name}`}
                className="max-h-72 w-full rounded-xl border border-slate-200 object-contain"
              />
            </div>
          ))}
        </Card>
      )}
    </div>
  );

  const safetyPanel = (
    <div className="space-y-4">
      <Card className="space-y-3">
        <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Official alerts
        </p>
        {context.alertMatches.length > 0 ? (
          <ul className="space-y-3">
            {context.alertMatches.map((alert, index) => (
              <li key={`${alert.product_name}-${index}`} className="space-y-1">
                <p className="text-[15px] font-semibold text-slate-900">
                  {alert.product_name}
                  {alert.batch_no ? ` · Batch ${alert.batch_no}` : ""}
                </p>
                <p className="text-[14px] text-slate-600">
                  {alert.matchType === "name_and_batch"
                    ? "Same name and batch"
                    : "Same name"}{" "}
                  · {alert.alert_type} · {formatDate(alert.alert_date) ?? alert.alert_date}
                </p>
                {alert.source_url && (
                  <a
                    href={alert.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[14px] font-semibold text-primary-700 underline"
                  >
                    Source
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-slate-500">
            No official alerts match this medicine.
          </p>
        )}
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Possible interactions
        </p>
        {interactions.length > 0 ? (
          <ul className="space-y-3">
            {interactions.map((pair, index) => (
              <li key={`${pair.ingredient_a}-${pair.ingredient_b}-${index}`} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold uppercase ${severityTone(
                      pair.severity
                    )}`}
                  >
                    {pair.severity}
                  </span>
                  <p className="text-[15px] font-semibold text-slate-900">
                    {pair.ingredient_a} + {pair.ingredient_b}
                  </p>
                </div>
                {pair.note && (
                  <p className="text-[14px] leading-snug text-slate-600">
                    {pair.note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-slate-500">
            No known interaction warnings for this composition.
          </p>
        )}
      </Card>

      <Card className="space-y-1">
        <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Community reports
        </p>
        <p className="text-[15px] text-slate-700">
          {context.communityReportCount > 0
            ? `${context.communityReportCount} ${
                context.communityReportCount === 1 ? "person has" : "people have"
              } reported a problem with this medicine.`
            : "No other people have reported a problem with this medicine yet."}
        </p>
      </Card>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={medicine.name} subtitle="Trust card" />

      <TrustCard
        medicineId={medicine.id}
        userId={user.id}
        initialRisk={{ level: result.level, reasons: result.reasons }}
        alertCount={context.alertMatches.length}
        onlineStatus={context.onlineStatus}
        jobStatus={context.jobStatus}
        lastCheckedAt={context.lastCheckedAt}
        onlineDemo={context.onlineCheck?.demo === true}
        expiresInDays={expiresInDays}
        reminderTimes={mealTimes}
        todayIst={istToday()}
        hasStripImage={Boolean(medicine.strip_image_path)}
        hasBoxImage={Boolean(medicine.box_image_path)}
        infoPanel={infoPanel}
        safetyPanel={safetyPanel}
      />

      <ScheduleList schedules={schedules} />
    </div>
  );
}
