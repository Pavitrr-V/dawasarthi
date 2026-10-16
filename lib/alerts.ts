import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertMatch } from "@/lib/risk";

/**
 * Official (NSQ) safety-alert helpers.
 *
 * - normalizeName / normalizeBatch: the single JS contract for matching. They
 *   mirror the SQL normalisers in 006_online_checks.sql so an alert imported by
 *   the agent, the CSV seed or a scan all compare the same way.
 * - matchAlerts: fuzzy-matches a medicine against nsq_alerts via the
 *   `match_nsq_alerts(name, threshold)` RPC and decides name_and_batch vs
 *   name_only in JS.
 * - parseAgentAlerts: validates the UNTRUSTED JSON the TinyFish agent returned
 *   (max 100 rows, strings trimmed to 200) and drops anything unusable.
 * - upsertNsqAlerts: writes alerts, never downgrading an existing row.
 */

/** Trigram similarity required before an alert is considered a name match. */
export const NSQ_MATCH_THRESHOLD = 0.6;
/** Hard cap on rows accepted from one agent run. */
export const MAX_ALERT_ROWS = 100;
/** Every stored string field is trimmed to this length. */
export const MAX_FIELD_LEN = 200;

// ---------------------------------------------------------------------------
// Normalisation (the JS mirror of the SQL normalisers)
// ---------------------------------------------------------------------------

/** Lowercase and collapse every separator to single spaces (word-preserving). */
export function normalizeName(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Lowercase and strip every non-alphanumeric character ("ct-503513c" == "CT503513C"). */
export function normalizeBatch(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ---------------------------------------------------------------------------
// "AUG-2026" -> "2026-08-01"
// ---------------------------------------------------------------------------

const MONTH_BY_ABBR: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Converts a reporting month such as "AUG-2026" into the first of that month
 * ("2026-08-01"), or null when it cannot be understood. Accepts common
 * separators and full/short month names ("SEPT 2026").
 */
export function monthYearToDate(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().toUpperCase().match(/^([A-Z]{3,9})[\s\-./]+(\d{4})$/);
  if (!match) return null;

  const month = MONTH_BY_ABBR[match[1].slice(0, 3)];
  if (!month) return null;

  const year = Number(match[2]);
  if (!Number.isFinite(year)) return null;

  return `${year}-${String(month).padStart(2, "0")}-01`;
}

// ---------------------------------------------------------------------------
// Parsing the (UNTRUSTED) agent result
// ---------------------------------------------------------------------------

const trim200 = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LEN) : "";

/** One alert row as the agent returned it. Bad rows fail this and are dropped. */
const agentAlertSchema = z.object({
  product_name: z.string(),
  batch_no: z.string().nullish(),
  manufacturer: z.string().nullish(),
  alert_type: z.string().nullish(),
  reporting_month_year: z.string().nullish(),
  source_link: z.string().nullish(),
});

const agentResultSchema = z.object({
  alerts: z.array(z.unknown()),
});

/** A validated, normalised row ready to be written to nsq_alerts. */
export type NsqAlertRow = {
  product_name: string;
  product_name_norm: string;
  batch_no: string;
  batch_no_norm: string;
  manufacturer: string;
  alert_type: string;
  alert_date: string;
  source_url: string;
  raw: Record<string, unknown>;
};

/**
 * Validates the agent's `{ alerts: [...] }` payload and turns it into rows.
 * Rows without a usable product name or month are dropped. `sourceUrl` is the
 * trusted page we scraped from (never a link the page itself invented).
 */
export function parseAgentAlerts(
  payload: unknown,
  sourceUrl: string
): NsqAlertRow[] {
  const outer = agentResultSchema.safeParse(payload);
  if (!outer.success) return [];

  const rows: NsqAlertRow[] = [];
  for (const item of outer.data.alerts.slice(0, MAX_ALERT_ROWS)) {
    const parsed = agentAlertSchema.safeParse(item);
    if (!parsed.success) continue;

    const productName = trim200(parsed.data.product_name);
    if (productName.length === 0) continue;

    const alertDate = monthYearToDate(parsed.data.reporting_month_year);
    if (alertDate === null) continue;

    const batchNo = trim200(parsed.data.batch_no);
    rows.push({
      product_name: productName,
      product_name_norm: normalizeName(productName),
      batch_no: batchNo,
      batch_no_norm: normalizeBatch(batchNo),
      manufacturer: trim200(parsed.data.manufacturer),
      // The task pins every scraped row to the official NSQ type.
      alert_type: "nsq",
      alert_date: alertDate,
      source_url: sourceUrl,
      raw: { source: "agent", reported: trim200(parsed.data.reporting_month_year) },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Matching a medicine against nsq_alerts
// ---------------------------------------------------------------------------

export type AlertQuery = {
  name?: string | null;
  batch_no?: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function matchTypeFor(
  medicineBatch: string,
  alertBatchNorm: string
): AlertMatch["matchType"] {
  const alertNorm = normalizeBatch(alertBatchNorm);
  return medicineBatch !== "" && alertNorm !== "" && alertNorm === medicineBatch
    ? "name_and_batch"
    : "name_only";
}

/** True when an nsq_alerts row's `raw` jsonb is marked as demo/seed data. */
function isDemoRaw(value: unknown): boolean {
  return asRecord(value)?.demo === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Fuzzy-matches a medicine name (and batch) against official alerts.
 * Returns [] when the name is too short, the RPC is missing, or anything else
 * goes wrong — the trust card simply shows "0 found".
 */
export async function matchAlerts(
  supabase: SupabaseClient,
  medicine: AlertQuery
): Promise<AlertMatch[]> {
  const name = text(medicine.name);
  if (name.length < 3) return [];

  const medicineBatch = normalizeBatch(medicine.batch_no);

  try {
    const { data, error } = await supabase.rpc("match_nsq_alerts", {
      p_name: name,
      p_threshold: NSQ_MATCH_THRESHOLD,
    });
    if (error || !Array.isArray(data)) return [];

    return data.flatMap((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const productName = text(row.product_name);
      if (productName.length === 0) return [];

      return [
        {
          alert_type: text(row.alert_type) || "other",
          product_name: productName,
          batch_no: text(row.batch_no) || null,
          alert_date: text(row.alert_date),
          source_url: text(row.source_url),
          matchType: matchTypeFor(medicineBatch, text(row.batch_no_norm)),
          ...(isDemoRaw(row.raw) ? { demo: true } : {}),
        } satisfies AlertMatch,
      ];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Writing alerts (never downgrading an existing row)
// ---------------------------------------------------------------------------

const WRITE_COLUMNS =
  "product_name_norm, batch_no_norm, alert_date, product_name, batch_no, manufacturer, alert_type, source_url, raw";

function better(current: string | null | undefined, incoming: string): string {
  const a = (current ?? "").trim();
  const b = incoming.trim();
  // Keep whichever side actually carries (longer) data; never blank a field.
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  return a.length >= b.length ? a : b;
}

function alertKey(
  nameNorm: string,
  batchNorm: string,
  alertDate: string
): string {
  // Mirrors the nsq_alerts unique key (product_name_norm, batch_no_norm,
  // alert_date). Uses the stored *_norm columns directly, which is the
  // authority the database enforces on conflict.
  return `${nameNorm}|${batchNorm}|${alertDate}`;
}

export type UpsertAlertsOptions = {
  /** Stamped into fetched_at; defaults to now. */
  fetchedAt?: string;
};

export type UpsertAlertsResult = {
  attempted: number;
  written: number;
};

/**
 * Upserts alerts on (product_name_norm, batch_no_norm, alert_date). Before
 * writing, existing rows are loaded once and merged so a row is never
 * downgraded (a null/shorter value never overwrites a real one). Uses the
 * service-role client; does not rely on .select() after the insert.
 */
export async function upsertNsqAlerts(
  admin: SupabaseClient,
  rows: NsqAlertRow[],
  options: UpsertAlertsOptions = {}
): Promise<UpsertAlertsResult> {
  if (rows.length === 0) return { attempted: 0, written: 0 };

  const fetchedAt = options.fetchedAt ?? new Date().toISOString();

  const { data: existingRows } = await admin
    .from("nsq_alerts")
    .select(WRITE_COLUMNS)
    .limit(5000);

  const existingByKey = new Map<string, Record<string, unknown>>();
  for (const row of (existingRows ?? []) as Record<string, unknown>[]) {
    existingByKey.set(
      alertKey(
        text(row.product_name_norm),
        text(row.batch_no_norm),
        text(row.alert_date)
      ),
      row
    );
  }

  const merged = rows.map((row) => {
    const current = existingByKey.get(
      alertKey(row.product_name_norm, row.batch_no_norm, row.alert_date)
    );
    const existingRaw = asRecord(current?.raw) ?? {};

    return {
      product_name_norm: row.product_name_norm,
      batch_no_norm: row.batch_no_norm,
      alert_date: row.alert_date,
      product_name: better(current?.product_name as string, row.product_name),
      batch_no: better(current?.batch_no as string, row.batch_no),
      manufacturer: better(current?.manufacturer as string, row.manufacturer),
      alert_type: row.alert_type,
      source_url: better(current?.source_url as string, row.source_url),
      fetched_at: fetchedAt,
      // Incoming keys win but existing ones are preserved, so a demo flag is
      // never lost when the same alert is re-ingested without it.
      raw: { ...existingRaw, ...row.raw },
    };
  });

  const { error } = await admin
    .from("nsq_alerts")
    .upsert(merged, { onConflict: "product_name_norm,batch_no_norm,alert_date" });

  if (error) {
    throw new Error(`Could not save alerts: ${error.message}`);
  }

  return { attempted: rows.length, written: merged.length };
}
