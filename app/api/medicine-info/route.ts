import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GeminiConfigError, GeminiRequestError } from "@/lib/gemini";
import {
  INFO_CACHE_TTL_DAYS,
  generateMedicineInfo,
  getLiveSourceText,
  normalizeCompositionKey,
  type CatalogReference,
} from "@/lib/medicine-info";
import type { MedicineInfo, MedicineInfoPayload } from "@/lib/types";

export const maxDuration = 60;

const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60 * 60;
const RATE_ROUTE = "medicine-info";
const TTL_MS = INFO_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  medicine_id: z.string().uuid().optional(),
  composition: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

type AdminClient = ReturnType<typeof createAdminClient>;

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function isFresh(iso: unknown): iso is string {
  if (typeof iso !== "string") return false;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return Date.now() - time < TTL_MS;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Counts one request for this user. Returns false when the hourly limit is
 * exceeded, true when allowed, and null when the counter is unavailable
 * (fail-open: the route keeps working before the migration is applied).
 */
async function withinRateLimit(
  admin: AdminClient,
  userId: string
): Promise<boolean | null> {
  const { data, error } = await admin.rpc("bump_rate_limit", {
    p_user_id: userId,
    p_route: RATE_ROUTE,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });

  if (error) {
    console.warn("[api/medicine-info] rate limit unavailable:", error.message);
    return null;
  }
  if (typeof data !== "number") return null;
  return data >= 0;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

function readMedicineCache(
  existingInfo: Record<string, unknown>
): MedicineInfo | null {
  const general = existingInfo.general;
  if (!general || typeof general !== "object" || Array.isArray(general)) {
    return null;
  }
  if (!isFresh(existingInfo.general_fetched_at)) return null;
  return general as MedicineInfo;
}

async function writeMedicineCache(
  admin: AdminClient,
  medicineId: string,
  existingInfo: Record<string, unknown>,
  info: MedicineInfo
): Promise<void> {
  // Merge so we never clobber sibling keys (e.g. info.second_side).
  const { error } = await admin
    .from("medicines")
    .update({
      info: {
        ...existingInfo,
        general: info,
        general_fetched_at: info.generated_at,
      },
    })
    .eq("id", medicineId);

  if (error) {
    console.warn("[api/medicine-info] medicine cache write failed:", error.message);
  }
}

async function readGlobalCache(
  admin: AdminClient,
  key: string
): Promise<MedicineInfo | null> {
  const { data, error } = await admin
    .from("info_cache")
    .select("payload, created_at")
    .eq("composition_key", key)
    .maybeSingle();

  if (error || !data) return null;
  if (!isFresh(data.created_at)) return null;
  return data.payload as MedicineInfo;
}

async function writeGlobalCache(
  admin: AdminClient,
  key: string,
  info: MedicineInfo
): Promise<void> {
  const { error } = await admin.from("info_cache").upsert(
    {
      composition_key: key,
      payload: info,
      source: info.live_source_used ? "llm+web" : "llm",
      model: info.model,
      created_at: info.generated_at,
      refreshed_at: new Date().toISOString(),
    },
    { onConflict: "composition_key" }
  );

  if (error) {
    console.warn("[api/medicine-info] info_cache write failed:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Catalog grounding
// ---------------------------------------------------------------------------

async function lookupCatalog(
  supabase: Awaited<ReturnType<typeof createClient>>,
  name: string | null,
  composition: string[]
): Promise<CatalogReference[]> {
  if (name) {
    const { data } = await supabase.rpc("search_medicine_catalog", {
      p_query: name,
      p_threshold: 0.3,
      p_limit: 3,
    });
    if (Array.isArray(data) && data.length > 0) {
      return data as CatalogReference[];
    }
  }

  if (composition.length > 0) {
    const { data } = await supabase
      .from("medicine_catalog")
      .select("name, composition, manufacturer, uses, side_effects")
      .overlaps("composition", composition)
      .limit(3);
    if (Array.isArray(data)) return data as CatalogReference[];
  }

  return [];
}

// ---------------------------------------------------------------------------
// POST /api/medicine-info
// ---------------------------------------------------------------------------

/**
 * LLM-only medicine info. Given { medicine_id } (preferred) or a raw
 * { composition } array, returns plain-language uses, dosage, side effects and
 * warnings, grounded on the catalog when possible.
 *
 * The LLM receives only the medicine name and composition (never personal
 * data). Results are cached for 30 days in medicines.info and info_cache, so
 * repeat views cost nothing. Rate limited to 10 requests per user per hour.
 *
 * Phase 3B will add live, source-backed text via TinyFish; today
 * getLiveSourceText returns null and the label says "General info (no live
 * source)".
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return fail("Please sign in again.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("We could not read the request. Please try again.");
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("Send a medicine id or a composition.");
  }

  const { medicine_id, composition: rawComposition } = parsed.data;
  if (!medicine_id && (!rawComposition || rawComposition.length === 0)) {
    return fail("Send a medicine id or a composition.");
  }

  // The cache and the rate limiter are server-only (service role).
  let admin: AdminClient;
  try {
    admin = createAdminClient();
  } catch {
    return fail(
      "The info service is not configured yet. Please try again later.",
      503
    );
  }

  const allowed = await withinRateLimit(admin, user.id);
  if (allowed === false) {
    return fail(
      "You have reached the limit of 10 info requests per hour. Please try again later.",
      429
    );
  }

  const supabase = await createClient();

  let name: string | null = null;
  let composition: string[] = [];
  let existingInfo: Record<string, unknown> = {};

  if (medicine_id) {
    const { data } = await supabase
      .from("medicines")
      .select("id, name, composition, info")
      .eq("id", medicine_id)
      .maybeSingle();

    if (!data) return fail("Medicine not found.", 404);

    name = typeof data.name === "string" ? data.name : null;
    composition = Array.isArray(data.composition) ? data.composition : [];
    existingInfo =
      data.info && typeof data.info === "object" && !Array.isArray(data.info)
        ? (data.info as Record<string, unknown>)
        : {};
  } else {
    composition = rawComposition ?? [];
  }

  const compositionKey = normalizeCompositionKey(composition);
  const cacheKey =
    compositionKey || (name ? `name:${name.toLowerCase().trim()}` : "");
  if (!cacheKey) {
    return fail("We need a composition or a medicine name to look this up.");
  }

  // 1. Medicine-level cache (medicines.info.general).
  if (medicine_id) {
    const cached = readMedicineCache(existingInfo);
    if (cached) {
      return NextResponse.json<MedicineInfoPayload>({ ...cached, cached: true });
    }
  }

  // 2. Global cache (info_cache), keyed by normalized composition.
  const globalCached = await readGlobalCache(admin, cacheKey);
  if (globalCached) {
    if (medicine_id) {
      // Backfill the medicine-level cache opportunistically (best effort).
      await writeMedicineCache(admin, medicine_id, existingInfo, globalCached);
    }
    return NextResponse.json<MedicineInfoPayload>({
      ...globalCached,
      cached: true,
    });
  }

  // 3. Not cached: ground on the catalog, then call the LLM.
  const catalog = await lookupCatalog(supabase, name, composition);
  const liveSourceText = await getLiveSourceText(composition);

  let info: MedicineInfo | null;
  try {
    info = await generateMedicineInfo({
      name,
      composition,
      catalog,
      liveSourceText,
    });
  } catch (error) {
    if (error instanceof GeminiConfigError) {
      return fail(
        "The info service is not configured yet. Please try again later.",
        503
      );
    }
    if (error instanceof GeminiRequestError) {
      return fail(
        "The info service is busy right now. Please try again in a moment.",
        503
      );
    }
    console.error("[api/medicine-info] generation failed", error);
    return fail("We could not fetch medicine info. Please try again.", 502);
  }

  if (!info) {
    return fail(
      "We could not read the medicine info clearly. Please try again.",
      422
    );
  }

  // 4. Cache the result (best effort; a cache failure must not fail the view).
  await writeGlobalCache(admin, cacheKey, info);
  if (medicine_id) {
    await writeMedicineCache(admin, medicine_id, existingInfo, info);
  }

  return NextResponse.json<MedicineInfoPayload>({
    ...info,
    cached: false,
  });
}
