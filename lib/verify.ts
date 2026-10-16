import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentRun } from "@/lib/tinyfish";
import { normalizeBatch, normalizeName } from "@/lib/alerts";
import { recomputeMedicineRiskWith } from "@/lib/risk-recompute";

/**
 * Server-only "online verification" of a medicine through the TinyFish agent.
 *
 * The agent opens a public listing page for the product and returns a small
 * JSON object. This module owns:
 *   - which source patterns to use (VERIFY_SOURCE_URLS) and the goal text;
 *   - validating that UNTRUSTED JSON (bounded strings, MRP and confidence);
 *   - finishing a `tinyfish_jobs` (kind='verify') row and writing the result
 *     into `online_verifications`, then recomputing the deterministic verdict.
 *
 * Hard rules:
 *   - The goal may contain ONLY the medicine name, composition and
 *     manufacturer. Never patient name/age/allergies/user id.
 *   - Everything the agent returns is untrusted: validate with zod-style
 *     bounds and never render it as HTML.
 *   - Verified facts can only ever move the verdict to AMBER; lib/risk.ts
 *     enforces that, this module does not decide colours.
 */

/** A recent completed check is reused instead of starting a new agent run. */
export const VERIFY_FRESH_MS = 24 * 60 * 60 * 1000;
/** A run that has not finished within this window is treated as failed. */
export const VERIFY_STALE_MS = 5 * 60 * 1000;
/** Status polling leaves jobs younger than this alone, so the agent can work. */
export const VERIFY_SETTLE_MS = 20 * 1000;
/** How many verify runs one user may start per rolling hour. */
export const VERIFY_MAX_PER_HOUR = 5;
/** At most this many source patterns are ever started for one medicine. */
export const VERIFY_SOURCE_LIMIT = 2;
/** Every stored string field is trimmed to this length. */
export const MAX_FIELD_LEN = 200;
/** A listed MRP must be strictly between 0 and this (exclusive). */
export const MAX_LISTED_MRP = 100000;

// ---------------------------------------------------------------------------
// Small coercion helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asTrimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, MAX_FIELD_LEN);
  return trimmed.length > 0 ? trimmed : null;
}

/** 0 < mrp < MAX_LISTED_MRP, rounded to paise; anything else is dropped. */
function asMrp(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed === null || parsed <= 0 || parsed >= MAX_LISTED_MRP) return null;
  return Math.round(parsed * 100) / 100;
}

/** A confidence outside 0..1 is dropped rather than clamped. */
function asConfidence(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed === null || parsed < 0 || parsed > 1) return null;
  return parsed;
}

function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

// ---------------------------------------------------------------------------
// Sources (VERIFY_SOURCE_URLS) + goal
// ---------------------------------------------------------------------------

export type VerifySource = {
  /** Display name (hostname without "www."), stored as source_site. */
  site: string;
  /** The URL pattern, with a `{query}` placeholder to fill with the name. */
  url: string;
};

/**
 * Parses VERIFY_SOURCE_URLS (comma-separated patterns, each containing a
 * `{query}` placeholder). Duplicate hosts are dropped and the list is capped at
 * VERIFY_SOURCE_LIMIT. Returns [] when the variable is unset or unusable.
 */
export function verifySources(): VerifySource[] {
  const raw = (process.env.VERIFY_SOURCE_URLS ?? "").trim();
  if (raw.length === 0) return [];

  const seen = new Set<string>();
  const sources: VerifySource[] = [];

  for (const part of raw.split(",")) {
    const pattern = part.trim();
    if (pattern.length === 0) continue;

    let host: string;
    try {
      host = new URL(pattern.replace(/\{query\}/g, "x")).hostname;
    } catch {
      continue;
    }

    const site = host.replace(/^www\./i, "");
    if (site.length === 0 || seen.has(site)) continue;
    seen.add(site);
    sources.push({ site, url: pattern });

    if (sources.length >= VERIFY_SOURCE_LIMIT) break;
  }

  return sources;
}

/** Fills the `{query}` placeholder with the (URL-encoded) medicine name. */
export function verifySearchUrl(pattern: string, name: string): string {
  const query = encodeURIComponent((name ?? "").trim());
  return pattern.replace(/\{query\}/g, query);
}

export type VerifyTarget = {
  name: string;
  composition?: string[] | null;
  manufacturer?: string | null;
};

/**
 * Builds the agent goal. Only the medicine's own printed details go in; no
 * patient information is ever included. `buildGoal()` (inside startAgentRun)
 * appends the untrusted-page / read-only guard.
 */
export function verifyGoal(target: VerifyTarget): string {
  const name = (target.name ?? "").trim() || "(unknown)";
  const composition =
    (target.composition ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .join(", ") || "(unknown)";
  const manufacturer = (target.manufacturer ?? "").trim() || "(unknown)";

  return [
    "Search for this medicine and open the best matching product page.",
    `Medicine name: ${name}`,
    `Composition: ${composition}`,
    `Manufacturer: ${manufacturer}`,
    "Extract these fields from the page:",
    '  "found"               <- true when the page is selling the same product, else false',
    '  "listed_name"         <- the product name shown on the page',
    '  "listed_mrp"          <- the listed price in INR as a number, else null',
    '  "listed_manufacturer" <- the manufacturer shown on the page',
    '  "listed_pack_size"    <- the pack size / quantity, e.g. "10 tablets"',
    '  "confidence"          <- 0..1 confidence that this is the same product',
    'Return a single JSON object with exactly these keys and no other text.',
    'If there is no matching product, return {"found": false}.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing the (UNTRUSTED) agent result
// ---------------------------------------------------------------------------

export type VerifyFacts = {
  listed_name: string | null;
  listed_mrp: number | null;
  listed_manufacturer: string | null;
  listed_pack_size: string | null;
  confidence: number | null;
};

export type ParsedVerifyResult =
  | { status: "found"; facts: VerifyFacts }
  | { status: "not_found" }
  | { status: "error"; message: string };

/**
 * Validates the agent's result and maps it to found / not_found / error.
 * Out-of-bounds values (an MRP of 0, a negative or huge price, a non-numeric
 * field, a confidence outside 0..1, an over-long string) are sanitised rather
 * than trusted: the field is dropped, the check still stands.
 */
export function parseVerifyResult(payload: unknown): ParsedVerifyResult {
  const record = asRecord(coerceJson(payload));
  if (!record) {
    return { status: "error", message: "The agent returned an unreadable result." };
  }

  const listedName = asTrimmed(record.listed_name);

  if (record.found === false) return { status: "not_found" };
  if (record.found !== true && listedName === null) return { status: "not_found" };

  return {
    status: "found",
    facts: {
      listed_name: listedName,
      listed_mrp: asMrp(record.listed_mrp),
      listed_manufacturer: asTrimmed(record.listed_manufacturer),
      listed_pack_size: asTrimmed(record.listed_pack_size),
      confidence: asConfidence(record.confidence),
    },
  };
}

// ---------------------------------------------------------------------------
// 24-hour cache + per-user rate limit
// ---------------------------------------------------------------------------

/** True when `lastFetchedAt` is within VERIFY_FRESH_MS of `now`. */
export function isFresh(
  lastFetchedAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!lastFetchedAt) return false;
  const fetched = new Date(lastFetchedAt).getTime();
  if (!Number.isFinite(fetched)) return false;
  return now.getTime() - fetched < VERIFY_FRESH_MS;
}

export type ProductKey = { name?: string | null; batch_no?: string | null };

/** Same normalised name AND same normalised batch ("" == "" allowed). */
export function sameProduct(a: ProductKey, b: ProductKey): boolean {
  const nameA = normalizeName(a.name ?? "");
  const nameB = normalizeName(b.name ?? "");
  if (nameA.length === 0 || nameA !== nameB) return false;
  return normalizeBatch(a.batch_no ?? "") === normalizeBatch(b.batch_no ?? "");
}

/** True once a user has reached their hourly verify-run budget. */
export function hourlyLimitReached(count: number): boolean {
  return count >= VERIFY_MAX_PER_HOUR;
}

/**
 * Looks for a recently completed check of the SAME product (normalised name +
 * batch), so re-scanning the identical pack does not start another agent run.
 * Uses the caller's client, so RLS scopes it to the user's own medicines.
 */
export async function hasFreshVerification(
  supabase: SupabaseClient,
  target: { name: string; batch_no: string | null },
  now: Date = new Date()
): Promise<boolean> {
  const since = new Date(now.getTime() - VERIFY_FRESH_MS).toISOString();

  try {
    const { data, error } = await supabase
      .from("online_verifications")
      .select("status, fetched_at, medicines!inner(name, batch_no)")
      .gte("fetched_at", since)
      .in("status", ["found", "not_found"])
      .limit(50);

    if (error || !Array.isArray(data)) return false;

    return data.some((entry) => {
      const record = asRecord(entry);
      const embedded = record?.medicines;
      const medicine = asRecord(
        Array.isArray(embedded) ? embedded[0] : embedded
      );
      if (!medicine) return false;
      return sameProduct(
        { name: text(medicine.name), batch_no: text(medicine.batch_no) },
        target
      );
    });
  } catch {
    return false;
  }
}

/** How many verify runs this user started in the last rolling hour. */
export async function countRecentVerifyStarts(
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  try {
    const { count, error } = await admin
      .from("tinyfish_jobs")
      .select("id", { count: "exact", head: true })
      .eq("kind", "verify")
      .eq("user_id", userId)
      .gte("created_at", since);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Finishing a job
// ---------------------------------------------------------------------------

export type VerifyJob = {
  id: string;
  medicine_id: string | null;
  run_id: string | null;
  created_at: string;
};

export type FinishOutcome = "done" | "failed" | "running";

type Admin = ReturnType<typeof createAdminClient>;

function isStale(createdAt: string): boolean {
  const started = new Date(createdAt).getTime();
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > VERIFY_STALE_MS;
}

/**
 * Atomically moves a running job to done/failed. The `status = 'running'`
 * guard means only the first worker to reach this point wins.
 */
async function markJob(
  admin: Admin,
  id: string,
  status: "done" | "failed",
  error: string | null
): Promise<void> {
  await admin
    .from("tinyfish_jobs")
    .update({ status, finished_at: new Date().toISOString(), error })
    .eq("id", id)
    .eq("status", "running")
    .select("id");
}

type VerificationPatch = {
  status: "found" | "not_found" | "error";
  listed_name?: string | null;
  listed_mrp?: number | null;
  listed_manufacturer?: string | null;
  listed_pack_size?: string | null;
  confidence?: number | null;
};

/**
 * Updates the pending `online_verifications` row tied to this job. The link is
 * the `raw.job_id` written at start time, so sibling checks for a different
 * source are left untouched. `raw` itself is preserved (a demo flag survives).
 */
async function markVerification(
  admin: Admin,
  jobId: string,
  patch: VerificationPatch
): Promise<void> {
  await admin
    .from("online_verifications")
    .update({ ...patch, fetched_at: new Date().toISOString() })
    .eq("raw->>job_id", jobId)
    .select("id");
}

async function recompute(admin: Admin, medicineId: string | null): Promise<void> {
  if (!medicineId) return;
  try {
    await recomputeMedicineRiskWith(admin, medicineId);
  } catch (error) {
    console.warn("[verify] risk recompute failed:", messageOf(error));
  }
}

/**
 * Polls one running verify job and, once the agent run has finished, writes the
 * validated result into online_verifications and recomputes the medicine's
 * verdict. Runs older than VERIFY_STALE_MS are failed so a stuck run cannot
 * wedge the queue. Transient upstream errors leave the job running to retry.
 */
export async function finishVerifyJob(job: VerifyJob): Promise<FinishOutcome> {
  const admin = createAdminClient();

  if (!job.run_id) {
    await markJob(admin, job.id, "failed", "Agent run id is missing.");
    await markVerification(admin, job.id, { status: "error" });
    return "failed";
  }

  if (isStale(job.created_at)) {
    const message = `Agent run did not finish within ${VERIFY_STALE_MS / 60000} minutes.`;
    await markJob(admin, job.id, "failed", message);
    await markVerification(admin, job.id, { status: "error" });
    return "failed";
  }

  let run;
  try {
    run = await getAgentRun(job.run_id);
  } catch (error) {
    if (isStale(job.created_at)) {
      await markJob(admin, job.id, "failed", messageOf(error));
      await markVerification(admin, job.id, { status: "error" });
      return "failed";
    }
    return "running";
  }

  if (run.status === "running") return "running";

  if (run.status === "failed") {
    await markJob(admin, job.id, "failed", run.error ?? "Agent run failed.");
    await markVerification(admin, job.id, { status: "error" });
    await recompute(admin, job.medicine_id);
    return "failed";
  }

  // COMPLETED: validate the untrusted payload and record the outcome.
  const parsed = parseVerifyResult(run.result);
  if (parsed.status === "found") {
    await markVerification(admin, job.id, {
      status: "found",
      listed_name: parsed.facts.listed_name,
      listed_mrp: parsed.facts.listed_mrp,
      listed_manufacturer: parsed.facts.listed_manufacturer,
      listed_pack_size: parsed.facts.listed_pack_size,
      confidence: parsed.facts.confidence,
    });
  } else if (parsed.status === "not_found") {
    await markVerification(admin, job.id, { status: "not_found" });
  } else {
    await markVerification(admin, job.id, { status: "error" });
  }
  await markJob(admin, job.id, "done", null);

  await recompute(admin, job.medicine_id);
  return "done";
}

// ---------------------------------------------------------------------------
// Batch runner (used by the status route and the cron)
// ---------------------------------------------------------------------------

export type VerifyBatchResult = {
  processed: number;
  done: number;
  failed: number;
  running: number;
};

export type ProcessVerifyOptions = {
  /** Only finish jobs for this medicine (used by the status route). */
  medicineId?: string;
  /** Skip jobs younger than this, giving the agent time to work. */
  minAgeMs?: number;
  limit?: number;
};

/**
 * Finishes up to `limit` running verify jobs. Called by the status route (for
 * one medicine, only jobs older than VERIFY_SETTLE_MS) and by the cron (all).
 */
export async function processRunningVerifyJobs(
  options: ProcessVerifyOptions = {}
): Promise<VerifyBatchResult> {
  const { medicineId, minAgeMs = 0, limit = 5 } = options;
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - minAgeMs).toISOString();

  const base = admin
    .from("tinyfish_jobs")
    .select("id, medicine_id, run_id, created_at")
    .eq("kind", "verify")
    .eq("status", "running")
    .lt("created_at", cutoff);

  const scoped = medicineId ? base.eq("medicine_id", medicineId) : base;

  const { data, error } = await scoped
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(data)) {
    return { processed: 0, done: 0, failed: 0, running: 0 };
  }

  let done = 0;
  let failed = 0;
  let running = 0;

  for (const job of data as VerifyJob[]) {
    const outcome = await finishVerifyJob(job);
    if (outcome === "done") done += 1;
    else if (outcome === "failed") failed += 1;
    else running += 1;
  }

  return { processed: data.length, done, failed, running };
}
