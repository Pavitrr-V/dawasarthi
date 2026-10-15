import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AlertMatch,
  type OnlineCheck,
  type OnlineCheckStatus,
  type PackSide,
  type RiskInput,
} from "@/lib/risk";

/**
 * Server-only helpers that turn a `medicines` row plus its online-check
 * signals (nsq_alerts, online_verifications, tinyfish_jobs, community
 * reports) into the pure `RiskInput` that `evaluateRisk` consumes.
 *
 * Everything here is defensive: if a migration has not been applied yet, a
 * lookup returns an empty result instead of throwing, so the trust card still
 * renders a verdict from whatever data is available.
 */

export const MEDICINE_RISK_COLUMNS =
  "id, patient_id, name, composition, batch_no, mfg_date, expiry_date, mrp, license_no, manufacturer, barcode, risk_level, risk_reasons, info, strip_image_path, box_image_path";

export type MedicineRiskRow = {
  id: string;
  patient_id: string;
  name: string;
  composition: string[] | null;
  batch_no: string | null;
  mfg_date: string | null;
  expiry_date: string | null;
  mrp: number | string | null;
  license_no: string | null;
  manufacturer: string | null;
  barcode: string | null;
  risk_level: string | null;
  risk_reasons: unknown;
  info: Record<string, unknown> | null;
  strip_image_path: string | null;
  box_image_path: string | null;
};

export type JobStatus = "queued" | "running" | "done" | "failed";

/** What the "Online listing" chip shows. */
export type OnlineChipStatus =
  | "checking"
  | "matched"
  | "not_found"
  | "failed"
  | "none";

export type MedicineRiskContext = {
  input: RiskInput;
  alertMatches: AlertMatch[];
  onlineCheck: OnlineCheck | null;
  onlineStatus: OnlineChipStatus;
  jobStatus: JobStatus | null;
  /** ISO timestamp of the last completed online check, for "Last checked". */
  lastCheckedAt: string | null;
  communityReportCount: number;
  secondSide: PackSide | null;
  datasetMatch: boolean | null;
};

// ---------------------------------------------------------------------------
// Small coercion helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

export function datasetMatchFromInfo(info: unknown): boolean | null {
  const record = asRecord(info);
  const value = record?.dataset_match;
  return typeof value === "boolean" ? value : null;
}

/** `info.second_side` is written by the "Scan other side" flow. */
export function secondSideFromInfo(info: unknown): PackSide | null {
  const record = asRecord(info);
  const side = asRecord(record?.second_side);
  if (!side) return null;

  const parsed: PackSide = {
    name: textOrNull(side.name),
    batch_no: textOrNull(side.batch_no),
    expiry_date: textOrNull(side.expiry_date),
  };
  if (!parsed.name && !parsed.batch_no && !parsed.expiry_date) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// NSQ alerts
// ---------------------------------------------------------------------------

function isAlertMatchType(value: unknown): value is AlertMatch["matchType"] {
  return value === "name_and_batch" || value === "name_only";
}

/**
 * Fuzzy-matches the medicine name (and batch) against nsq_alerts. Returns []
 * when the medicine has no usable name, the RPC is missing, or anything else
 * goes wrong.
 */
export async function loadAlertMatches(
  supabase: SupabaseClient,
  name: string,
  batchNo: string | null
): Promise<AlertMatch[]> {
  if (name.trim().length < 3) return [];

  try {
    const { data, error } = await supabase.rpc("match_nsq_alerts", {
      p_product_name: name,
      p_batch_no: batchNo,
      p_threshold: 0.4,
      p_limit: 5,
    });
    if (error || !Array.isArray(data)) return [];

    return data.flatMap((row) => {
      const record = asRecord(row);
      if (!record) return [];
      const matchType = record.match_type;
      if (!isAlertMatchType(matchType)) return [];
      const alertType = textOrNull(record.alert_type) ?? "other";
      const productName = textOrNull(record.product_name);
      if (!productName) return [];
      const alertDate = textOrNull(record.alert_date) ?? "";
      const sourceUrl = textOrNull(record.source_url) ?? "";
      return [
        {
          alert_type: alertType,
          product_name: productName,
          batch_no: textOrNull(record.batch_no),
          alert_date: alertDate,
          source_url: sourceUrl,
          matchType,
        } satisfies AlertMatch,
      ];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Online verification (TinyFish result)
// ---------------------------------------------------------------------------

const ONLINE_STATUSES: OnlineCheckStatus[] = [
  "pending",
  "found",
  "not_found",
  "error",
];

function onlineStatus(value: unknown): OnlineCheckStatus {
  return typeof value === "string" &&
    (ONLINE_STATUSES as string[]).includes(value)
    ? (value as OnlineCheckStatus)
    : "pending";
}

export async function loadOnlineCheck(
  supabase: SupabaseClient,
  medicineId: string
): Promise<{ check: OnlineCheck | null; lastCheckedAt: string | null }> {
  try {
    const { data, error } = await supabase
      .from("online_verifications")
      .select(
        "status, listed_mrp, listed_manufacturer, source_url, confidence, fetched_at, created_at"
      )
      .eq("medicine_id", medicineId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !Array.isArray(data) || data.length === 0) {
      return { check: null, lastCheckedAt: null };
    }

    const row = asRecord(data[0]);
    if (!row) return { check: null, lastCheckedAt: null };

    const check: OnlineCheck = {
      status: onlineStatus(row.status),
      listed_mrp: numberOrNull(row.listed_mrp),
      listed_manufacturer: textOrNull(row.listed_manufacturer),
      source_url: textOrNull(row.source_url),
      confidence: numberOrNull(row.confidence),
    };

    const lastCheckedAt = textOrNull(row.fetched_at);
    return { check, lastCheckedAt };
  } catch {
    return { check: null, lastCheckedAt: null };
  }
}

export async function loadLatestJob(
  supabase: SupabaseClient,
  medicineId: string
): Promise<{ status: JobStatus | null; finishedAt: string | null }> {
  try {
    const { data, error } = await supabase
      .from("tinyfish_jobs")
      .select("status, finished_at, created_at")
      .eq("medicine_id", medicineId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !Array.isArray(data) || data.length === 0) {
      return { status: null, finishedAt: null };
    }

    const row = asRecord(data[0]);
    const status = row?.status;
    if (status !== "queued" && status !== "running" && status !== "done" && status !== "failed") {
      return { status: null, finishedAt: null };
    }
    return { status, finishedAt: textOrNull(row?.finished_at) };
  } catch {
    return { status: null, finishedAt: null };
  }
}

// ---------------------------------------------------------------------------
// Community reports

/**
 * Counts all reports for a medicine. RLS only exposes the signed-in user's own
 * reports, so this needs the service-role client to see the community total.
 */
export async function countCommunityReports(
  admin: SupabaseClient | null,
  medicineId: string
): Promise<number> {
  if (!admin) return 0;
  try {
    const { count, error } = await admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("medicine_id", medicineId);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function onlineChipStatus(
  check: OnlineCheck | null,
  jobStatus: JobStatus | null
): OnlineChipStatus {
  if (jobStatus === "queued" || jobStatus === "running") return "checking";
  if (check) {
    if (check.status === "pending") return "checking";
    if (check.status === "found") return "matched";
    if (check.status === "not_found") return "not_found";
    return "failed";
  }
  if (jobStatus === "failed") return "failed";
  return "none";
}

/**
 * Builds the `RiskInput` for one medicine. `admin` is optional: without it the
 * community-report count is 0 rather than failing the whole page.
 */
export async function buildRiskContext({
  supabase,
  medicine,
  admin = null,
}: {
  supabase: SupabaseClient;
  medicine: MedicineRiskRow;
  admin?: SupabaseClient | null;
}): Promise<MedicineRiskContext> {
  const [alertMatches, online, job, communityReportCount] = await Promise.all([
    loadAlertMatches(supabase, medicine.name, medicine.batch_no),
    loadOnlineCheck(supabase, medicine.id),
    loadLatestJob(supabase, medicine.id),
    countCommunityReports(admin, medicine.id),
  ]);

  const secondSide = secondSideFromInfo(medicine.info);
  const datasetMatch = datasetMatchFromInfo(medicine.info);

  const input: RiskInput = {
    name: medicine.name,
    composition: medicine.composition ?? [],
    batch_no: medicine.batch_no,
    mfg_date: medicine.mfg_date,
    expiry_date: medicine.expiry_date,
    mrp: numberOrNull(medicine.mrp),
    license_no: medicine.license_no,
    manufacturer: medicine.manufacturer,
    secondSide,
    datasetMatch,
    communityReportCount,
    today: new Date(),
    alertMatches,
    onlineCheck: online.check,
  };

  return {
    input,
    alertMatches,
    onlineCheck: online.check,
    onlineStatus: onlineChipStatus(online.check, job.status),
    jobStatus: job.status,
    lastCheckedAt: online.lastCheckedAt ?? job.finishedAt,
    communityReportCount,
    secondSide,
    datasetMatch,
  };
}
