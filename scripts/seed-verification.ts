import "dotenv/config";
import { config } from "dotenv";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });

/**
 * Inserts one cached `online_verifications` row (raw.demo = true) so the trust
 * card's "Online checks" strip can be shown without a live TinyFish run. The
 * card renders a small "Demo data" label for these rows.
 *
 * Run: npx tsx scripts/seed-verification.ts <medicine_id> [--dry-run]
 */

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

type VerificationRow = {
  medicine_id: string;
  source_site: string;
  source_url: string;
  status: "found";
  listed_name: string;
  listed_mrp: number;
  listed_manufacturer: string;
  listed_pack_size: string;
  confidence: number;
  fetched_at: string;
  raw: Record<string, unknown>;
};

function buildRow(medicineId: string): VerificationRow {
  return {
    medicine_id: medicineId,
    source_site: "1mg.com",
    source_url: "https://www.1mg.com/search/all?name=demo",
    status: "found",
    listed_name: "Demo medicine",
    listed_mrp: 57.5,
    listed_manufacturer: "Demo Pharma Pvt Ltd",
    listed_pack_size: "10 tablets",
    confidence: 0.92,
    fetched_at: new Date().toISOString(),
    raw: { demo: true, source: "seed" },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const medicineId = args.find((arg) => !arg.startsWith("--"));

  if (!medicineId) {
    throw new Error(
      "Usage: npx tsx scripts/seed-verification.ts <medicine_id> [--dry-run]"
    );
  }

  const row = buildRow(medicineId);

  console.log("MedScan online-verification seeder");
  console.log(`Medicine: ${medicineId}`);

  if (dryRun) {
    console.log("--dry-run: nothing written.");
    console.log(row);
    return;
  }

  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { error } = await supabase.from("online_verifications").insert(row);
  if (error) throw new Error(error.message);

  console.log("Inserted one demo online verification (status=found, demo=true).");
}

main().catch((error: unknown) => {
  console.error("\nSeed error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
