
import "dotenv/config";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const CSV_PATH = resolve(process.cwd(), "data/medicines.csv");
const TABLE_NAME = "medicine_catalog";
const BATCH_SIZE = 500;
const EXISTING_PAGE_SIZE = 1000;

interface CsvMedicine {
  id?: string;
  name?: string;
  "price(₹)"?: string;
  Is_discontinued?: string;
  manufacturer_name?: string;
  type?: string;
  pack_size_label?: string;
  short_composition1?: string;
  short_composition2?: string;
}

interface CatalogMedicine {
  name: string;
  composition: string[];
  manufacturer: string | null;
  uses: null;
  side_effects: null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.SUPABASE_SECRET_KEY?.trim();

if (!serviceRoleKey) {
  throw new Error(
    "Missing SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in .env.local",
  );
}

const supabase = createClient(
  supabaseUrl,
  serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Examples:
 * "Amoxycillin (500mg)" -> "amoxycillin"
 * "Azithromycin (500mg)" -> "azithromycin"
 * Empty values -> omitted
 */
function normalizeIngredient(value: unknown): string | null {
  const ingredient = clean(value)
    // Remove parenthesized strengths containing a digit.
    .replace(/\s*\([^)]*\d[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return ingredient || null;
}

function mapMedicine(row: CsvMedicine): CatalogMedicine | null {
  const name = clean(row.name);

  if (!name) {
    return null;
  }

  const composition = [
    normalizeIngredient(row.short_composition1),
    normalizeIngredient(row.short_composition2),
  ].filter((value): value is string => value !== null);

  // Avoid duplicate ingredients within the same medicine.
  const uniqueComposition = [...new Set(composition)];

  return {
    name,
    composition: uniqueComposition,
    manufacturer: clean(row.manufacturer_name) || null,
    uses: null,
    side_effects: null,
  };
}

function openCsv() {
  return createReadStream(CSV_PATH).pipe(
    parse({
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    }),
  );
}

/**
 * First pass: count CSV data rows for accurate progress output.
 * The file is streamed and is not loaded into memory.
 */
async function countCsvRows(): Promise<number> {
  let count = 0;

  for await (const _row of openCsv()) {
    count++;
  }

  return count;
}

/**
 * Fetch all existing medicine names using pagination.
 * This is used in --force mode to resume safely without
 * re-importing names already present in the table.
 */
async function fetchExistingNames(): Promise<Set<string>> {
  const names = new Set<string>();

  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("name")
      .range(offset, offset + EXISTING_PAGE_SIZE - 1);

    if (error) {
      throw new Error(
        `Could not read existing catalog names: ${error.message}`,
      );
    }

    for (const row of data ?? []) {
      if (typeof row.name === "string" && row.name.trim()) {
        names.add(row.name.trim().toLowerCase());
      }
    }

    if (!data || data.length < EXISTING_PAGE_SIZE) {
      break;
    }

    offset += EXISTING_PAGE_SIZE;
  }

  return names;
}

async function getCatalogCount(): Promise<number> {
  const { count, error } = await supabase
    .from(TABLE_NAME)
    .select("id", { count: "exact", head: true });

  if (error) {
    throw new Error(
      `Could not check the catalog table: ${error.message}`,
    );
  }

  return count ?? 0;
}

async function insertBatchWithRetry(
  batch: CatalogMedicine[],
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { error } = await supabase
      .from(TABLE_NAME)
      .insert(batch);

    if (!error) {
      return;
    }

    console.error(
      `Batch insert failed (attempt ${attempt}/2): ${error.message}`,
    );

    if (attempt === 2) {
      throw new Error(
        `Batch failed after retry: ${error.message}`,
      );
    }

    // Brief delay before the one permitted retry.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");

  const unknownArgs = process.argv
    .slice(2)
    .filter((arg) => arg !== "--force");

  if (unknownArgs.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknownArgs.join(", ")}. Use --force if needed.`,
    );
  }

  console.log("MedScan medicine catalog importer");
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`Table: ${TABLE_NAME}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  const totalRows = await countCsvRows();

  if (totalRows === 0) {
    console.log("CSV contains no data rows. Nothing to import.");
    return;
  }

  console.log(`CSV rows: ${totalRows}`);

  const existingCount = await getCatalogCount();

  if (existingCount > 0 && !force) {
    throw new Error(
      `The catalog already contains ${existingCount} rows. ` +
        "No data was changed. Use --force to append missing medicines " +
        "while skipping names that already exist.",
    );
  }

  const existingNames = force
    ? await fetchExistingNames()
    : new Set<string>();

  console.log(`Existing names loaded: ${existingNames.size}`);
  console.log("Starting import...\n");

  let processed = 0;
  let inserted = 0;
  let skippedEmptyName = 0;
  let skippedDuplicate = 0;
  let failed = 0;

  let batch: CatalogMedicine[] = [];
  let batchNames: string[] = [];

  async function flushBatch(): Promise<void> {
    if (batch.length === 0) return;

    const currentBatch = batch;
    const currentNames = batchNames;

    batch = [];
    batchNames = [];

    try {
      await insertBatchWithRetry(currentBatch);

      inserted += currentBatch.length;

      for (const name of currentNames) {
        existingNames.add(name);
      }
    } catch (error) {
      failed += currentBatch.length;
      throw error;
    }
  }

  try {
    for await (const row of openCsv()) {
      processed++;

      const medicine = mapMedicine(row as CsvMedicine);

      if (!medicine) {
        skippedEmptyName++;
      } else {
        const nameKey = medicine.name.toLowerCase();

        if (
          existingNames.has(nameKey) ||
          batchNames.includes(nameKey)
        ) {
          skippedDuplicate++;
        } else {
          batch.push(medicine);
          batchNames.push(nameKey);
        }
      }

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }

      if (processed % 5000 === 0 || processed === totalRows) {
        console.log(
          `Processed ${processed} / ${totalRows} | ` +
            `Inserted ${inserted} | ` +
            `Skipped ${skippedDuplicate + skippedEmptyName}`,
        );
      }
    }

    await flushBatch();
  } catch (error) {
    console.error("\nImport stopped because a batch failed.");
    console.error(
      error instanceof Error ? error.message : error,
    );
    console.error("Successfully inserted batches remain in Supabase.");
    console.error("Use --force to resume; existing names will be skipped.");
    throw error;
  } finally {
    console.log("\n========== IMPORT SUMMARY ==========");
    console.log(`CSV rows processed: ${processed} / ${totalRows}`);
    console.log(`Successfully inserted: ${inserted}`);
    console.log(`Skipped empty names: ${skippedEmptyName}`);
    console.log(`Skipped existing/duplicate names: ${skippedDuplicate}`);
    console.log(`Rows in failed batches: ${failed}`);
    console.log("====================================");
  }
}

main().catch((error: unknown) => {
  console.error(
    "\nImport error:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
