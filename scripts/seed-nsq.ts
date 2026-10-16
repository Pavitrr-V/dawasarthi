import "dotenv/config";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import {
  MAX_FIELD_LEN,
  monthYearToDate,
  normalizeBatch,
  normalizeName,
  upsertNsqAlerts,
  type NsqAlertRow,
} from "../lib/alerts";

config({ path: resolve(process.cwd(), ".env.local") });

/**
 * Seeds nsq_alerts from data/nsq_demo.csv with the service role. This is the
 * offline fallback for the TinyFish alert-sync cron, and the source of the
 * "DEMO" rows that power the /demo-alert page.
 *
 * Run: npx tsx scripts/seed-nsq.ts [--dry-run]
 */

const CSV_PATH = resolve(process.cwd(), "data/nsq_demo.csv");
const DEFAULT_ALERT_SOURCE_URL =
  "https://cdscoonline.gov.in/CDSCO/viewPublicNSQDrug";

const ALLOWED_ALERT_TYPES = new Set([
  "nsq",
  "spurious",
  "adulterated",
  "misbranded",
  "other",
]);

type CsvRow = {
  product_name?: string;
  batch_no?: string;
  manufacturer?: string;
  alert_type?: string;
  alert_date?: string;
  source_url?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LEN) : "";
}

/** Accepts "2026-08-01" as-is, or converts "AUG-2026" -> "2026-08-01". */
function toAlertDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return monthYearToDate(value);
}

/** Placeholder cells from the CSV template must never be imported. */
function isPlaceholder(...values: string[]): boolean {
  return values.some((value) => /YOUR_|REPLACE_/i.test(value));
}

function isDemo(productName: string, sourceUrl: string): boolean {
  return (
    /^DEMO\b/i.test(productName) || sourceUrl.toLowerCase().includes("demo-alert")
  );
}

function alertType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ALLOWED_ALERT_TYPES.has(normalized) ? normalized : "nsq";
}

function buildRows(): { rows: NsqAlertRow[]; skipped: number } {
  const raw = readFileSync(CSV_PATH, "utf8");
  const records = parse(raw, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  const fallbackSource =
    (process.env.ALERT_SOURCE_URL ?? "").trim() || DEFAULT_ALERT_SOURCE_URL;

  const rows: NsqAlertRow[] = [];
  let skipped = 0;

  for (const record of records) {
    const productName = clean(record.product_name);
    const batchNo = clean(record.batch_no);
    const manufacturer = clean(record.manufacturer);
    const sourceUrl = clean(record.source_url) || fallbackSource;

    if (!productName || isPlaceholder(productName, batchNo, manufacturer, sourceUrl)) {
      skipped += 1;
      continue;
    }

    const alertDate = toAlertDate(clean(record.alert_date));
    if (!alertDate) {
      skipped += 1;
      continue;
    }

    const demo = isDemo(productName, sourceUrl);

    rows.push({
      product_name: productName,
      product_name_norm: normalizeName(productName),
      batch_no: batchNo,
      batch_no_norm: normalizeBatch(batchNo),
      manufacturer,
      alert_type: alertType(clean(record.alert_type)),
      alert_date: alertDate,
      source_url: sourceUrl,
      raw: { source: "csv", ...(demo ? { demo: true } : {}) },
    });
  }

  return { rows, skipped };
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  console.log("MedScan NSQ alert seeder");
  console.log(`CSV: ${CSV_PATH}`);

  const { rows, skipped } = buildRows();
  console.log(`Parsed rows: ${rows.length} (skipped ${skipped})`);

  if (dryRun) {
    console.log("--dry-run: nothing written.");
    for (const row of rows) {
      console.log(
        `- ${row.product_name} | batch=${row.batch_no || "(none)"} | ` +
          `${row.alert_type} | ${row.alert_date} | demo=${row.raw.demo === true}`
      );
    }
    return;
  }

  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const result = await upsertNsqAlerts(supabase, rows, {
    fetchedAt: new Date().toISOString(),
  });

  console.log(`Upserted ${result.written} / ${result.attempted} row(s).`);
}

main().catch((error: unknown) => {
  console.error("\nSeed error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
