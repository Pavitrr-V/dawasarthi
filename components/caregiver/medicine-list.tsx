import type { CaregiverMedicine } from "@/lib/types";
import { Card } from "@/components/ui";
import { TrustDot } from "./trust-dot";

export function CaregiverMedicineList({
  medicines,
}: {
  medicines: CaregiverMedicine[];
}) {
  if (medicines.length === 0) {
    return (
      <Card className="text-[15px] text-slate-500">
        No medicines recorded for this patient.
      </Card>
    );
  }

  return (
    <ul className="space-y-2" aria-label="Patient medicines">
      {medicines.map((medicine) => (
        <li key={medicine.id}>
          <Card className="space-y-2">
            {medicine.has_batch_alert && (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[15px] font-semibold text-red-700"
              >
                Official alert on this medicine&apos;s batch
              </p>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[17px] font-semibold text-slate-900">
                  {medicine.name}
                </p>
                <p className="text-[15px] text-slate-500">
                  Batch {medicine.batch_no ?? "—"}
                  {medicine.expiry_date ? ` · Exp ${medicine.expiry_date}` : ""}
                </p>
              </div>
              <TrustDot level={medicine.risk_level} />
            </div>
            {medicine.has_batch_alert && medicine.alert_message && (
              <p className="text-[15px] text-red-700">{medicine.alert_message}</p>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}
