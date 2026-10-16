import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AuthError,
  BudgetExceeded,
  ConfigError,
  RateLimitError,
  UpstreamError,
  startAgentRun,
  tinyfishEnabled,
} from "@/lib/tinyfish";
import {
  countRecentVerifyStarts,
  hasFreshVerification,
  hourlyLimitReached,
  verifyGoal,
  verifySearchUrl,
  verifySources,
} from "@/lib/verify";

export const maxDuration = 60;

const bodySchema = z.object({
  medicine_id: z.string().uuid(),
});

type VerifyMedicine = {
  id: string;
  name: string;
  composition: string[] | null;
  manufacturer: string | null;
  batch_no: string | null;
};

/**
 * Starts the online (TinyFish) verification of a scanned medicine.
 *
 * This is deliberately fire-and-forget: the scan form calls it without awaiting
 * and ignores the response, so nothing here can break saving. It:
 *   1. proves ownership through RLS (the caller's client),
 *   2. reuses a recent check of the same product (24h cache) or refuses politely
 *      when the user has started too many checks this hour (429),
 *   3. for each configured source (<= 2) starts one budget-guarded agent run and
 *      records a running `tinyfish_jobs` row plus a `pending`
 *      `online_verifications` row. The run is finished later by the status
 *      route or the cron.
 *
 * The goal contains only the medicine name/composition/manufacturer — never any
 * patient data.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (user.role !== "patient") {
    return NextResponse.json(
      { error: "Only a patient account can run this check." },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A medicine id is required." },
      { status: 400 }
    );
  }

  // Ownership + printed details through the user's client (RLS).
  const supabase = await createClient();
  const { data } = await supabase
    .from("medicines")
    .select("id, name, composition, manufacturer, batch_no")
    .eq("id", parsed.data.medicine_id)
    .maybeSingle();

  if (!data) {
    return NextResponse.json({ error: "Medicine not found." }, { status: 404 });
  }
  const medicine = data as unknown as VerifyMedicine;

  if (!tinyfishEnabled()) {
    return NextResponse.json({ ok: true, skipped: "disabled", started: [] });
  }

  const sources = verifySources();
  if (sources.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: "disabled",
      reason: "No VERIFY_SOURCE_URLS configured.",
      started: [],
    });
  }

  // A recent completed check of the same product is reused.
  if (
    await hasFreshVerification(supabase, {
      name: medicine.name,
      batch_no: medicine.batch_no,
    })
  ) {
    return NextResponse.json({ ok: true, skipped: "cached", started: [] });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ ok: true, skipped: "disabled", started: [] });
  }

  const recent = await countRecentVerifyStarts(admin, user.id);
  if (hourlyLimitReached(recent)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "You have started several checks in the last hour. Please try again shortly.",
      },
      { status: 429, headers: { "Retry-After": "600" } }
    );
  }

  const goal = verifyGoal({
    name: medicine.name,
    composition: medicine.composition,
    manufacturer: medicine.manufacturer,
  });

  const started: { site: string; job_id: string; run_id: string }[] = [];
  let budgetExhausted = false;

  for (const source of sources) {
    const searchUrl = verifySearchUrl(source.url, medicine.name);

    let runId: string;
    try {
      runId = (await startAgentRun({ url: searchUrl, goal })).runId;
    } catch (error) {
      // Budget/disabled: stop quietly with whatever already started.
      if (error instanceof BudgetExceeded || error instanceof ConfigError) {
        budgetExhausted = true;
        break;
      }
      // Could not start this source (auth/rate/upstream); try the next one.
      if (
        error instanceof AuthError ||
        error instanceof RateLimitError ||
        error instanceof UpstreamError
      ) {
        continue;
      }
      continue;
    }

    const jobId = crypto.randomUUID();
    const { error: jobError } = await admin.from("tinyfish_jobs").insert({
      id: jobId,
      kind: "verify",
      medicine_id: medicine.id,
      user_id: user.id,
      run_id: runId,
      status: "running",
    });
    if (jobError) continue;

    await admin.from("online_verifications").insert({
      medicine_id: medicine.id,
      source_site: source.site,
      source_url: searchUrl,
      status: "pending",
      raw: { job_id: jobId, source: "verify", site: source.site },
    });

    started.push({ site: source.site, job_id: jobId, run_id: runId });
  }

  if (started.length === 0 && budgetExhausted) {
    return NextResponse.json({ ok: true, skipped: "disabled", started });
  }

  return NextResponse.json({
    ok: true,
    ...(budgetExhausted ? { skipped: "disabled" } : {}),
    started,
  });
}
