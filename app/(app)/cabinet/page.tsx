import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPatientContext } from "@/lib/patients";
import { createClient } from "@/lib/supabase/server"; // adjust path if yours differs
import { EmptyState, PageHeader } from "@/components/ui";

export const instant = false;

type Inventory = {
  quantity_left: number | null;
  low_stock_threshold: number | null;
  unit: string | null;
};

type Row = {
  id: string;
  name: string;
  expiry_date: string | null;
  risk_level: "green" | "amber" | "red" | null;
  inventory: Inventory | Inventory[] | null;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "expiring", label: "Expiring this month" },
  { key: "expired", label: "Expired" },
  { key: "low", label: "Low stock" },
] as const;

const DOT: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

function firstInv(inv: Row["inventory"]): Inventory | null {
  if (!inv) return null;
  return Array.isArray(inv) ? (inv[0] ?? null) : inv;
}

function daysToExpiry(expiry: string | null, now: number): number | null {
  if (!expiry) return null;
  const t = new Date(expiry).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / 86_400_000);
}

export default async function CabinetPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await connection(); // request-time render, so Date.now() below is allowed
  await requireRole("patient");

  const { filter = "all" } = await searchParams;
  const { selected } = await getPatientContext();

  if (!selected) {
    return (
      <div className="space-y-4">
        <PageHeader title="Cabinet" subtitle="Your scanned medicines live here." />
        <EmptyState
          title="No profile selected"
          description="Create or select a patient profile first."
        />
      </div>
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("medicines")
    .select(
      "id, name, expiry_date, risk_level, inventory(quantity_left, low_stock_threshold, unit)"
    )
    .eq("patient_id", selected.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[cabinet] query failed:", error.message);
    return (
      <div className="space-y-4">
        <PageHeader title="Cabinet" subtitle="Your scanned medicines live here." />
        <EmptyState title="Could not load cabinet" description={error.message} />
      </div>
    );
  }

  const now = Date.now();
  const rows = ((data ?? []) as unknown as Row[]).map((m) => {
    const inv = firstInv(m.inventory);
    const days = daysToExpiry(m.expiry_date, now);
    const qty = inv?.quantity_left ?? null;
    const threshold = inv?.low_stock_threshold ?? 5;
    return {
      ...m,
      qty,
      unit: inv?.unit ?? "tablets",
      days,
      expired: days !== null && days < 0,
      expiring: days !== null && days >= 0 && days <= 30,
      low: qty !== null && qty <= threshold,
    };
  });

  const expiringCount = rows.filter((r) => r.expiring).length;
  const lowCount = rows.filter((r) => r.low).length;

  const visible = rows.filter((r) => {
    if (filter === "expiring") return r.expiring;
    if (filter === "expired") return r.expired;
    if (filter === "low") return r.low;
    return true;
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cabinet"
        subtitle="Your scanned medicines live here with stock and expiry."
      />

      {(expiringCount > 0 || lowCount > 0) && (
        <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-base text-amber-900">
          {expiringCount > 0 && (
            <p>
              {expiringCount} medicine{expiringCount > 1 ? "s" : ""} expire this month
            </p>
          )}
          {lowCount > 0 && <p>{lowCount} running low</p>}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/cabinet" : `/cabinet?filter=${f.key}`}
            className={`min-h-12 shrink-0 rounded-full border px-4 py-3 text-base ${
              filter === f.key
                ? "border-teal-600 bg-teal-600 text-white"
                : "border-slate-300 bg-white text-slate-700"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Your cabinet is empty"
          description="Scan your first medicine to add it here."
        />
      ) : visible.length === 0 ? (
        <EmptyState title="Nothing here" description="No medicines match this filter." />
      ) : (
        <ul className="space-y-3">
          {visible.map((m) => (
            <li key={m.id}>
              <Link
                href={`/medicine/${m.id}`}
                className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-2 h-3 w-3 shrink-0 rounded-full ${
                      DOT[m.risk_level ?? ""] ?? "bg-slate-300"
                    }`}
                    aria-label={`Risk: ${m.risk_level ?? "unknown"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-semibold text-slate-900">{m.name}</p>
                    <p className="text-base text-slate-600">
                      {m.expiry_date
                        ? m.expired
                          ? `Expired ${Math.abs(m.days ?? 0)} days ago`
                          : `Expires ${m.expiry_date} (${m.days} days)`
                        : "Expiry not set"}
                    </p>
                    <p
                      className={`text-base ${m.low ? "font-semibold text-red-600" : "text-slate-600"}`}
                    >
                      {m.qty === null ? "Stock: Not set" : `${m.qty} ${m.unit} left`}
                      {m.low ? " · running low" : ""}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}