import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  GeminiConfigError,
  GeminiRequestError,
  extractMedicineFromImage,
} from "@/lib/gemini";
import {
  SCAN_MODES,
  type MedicineExtraction,
  type ScanMode,
} from "@/lib/extraction";
import { MEDICINE_IMAGES_BUCKET } from "@/lib/constants";

export const maxDuration = 60;

const requestSchema = z.object({
  mode: z.enum(SCAN_MODES),
  paths: z.array(z.string().min(1).max(400)).min(1).max(2),
});

type Failure = NextResponse<{ error: string }>;

function fail(error: string, status = 400): Failure {
  return NextResponse.json({ error }, { status });
}

const DOWNLOAD_ATTEMPTS = 3;

/** Storage reads occasionally blip — retry a couple of times before failing. */
async function downloadImage(
  admin: ReturnType<typeof createAdminClient>,
  path: string
): Promise<Blob | null> {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const { data, error } = await admin.storage
      .from(MEDICINE_IMAGES_BUCKET)
      .download(path);

    if (data) return data;

    console.error(
      `[api/extract] storage download failed (${attempt}/${DOWNLOAD_ATTEMPTS})`,
      path,
      error?.message
    );
    if (attempt < DOWNLOAD_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  return null;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return fail("Please sign in again.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("We could not read the request. Please try again.");
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return fail("Send a mode and one or two image paths.");
  }

  const { mode, paths } = parsed.data;

  // The service client bypasses RLS, so verify each path is in this user's
  // own storage folder before reading it.
  for (const path of paths) {
    if (!path.startsWith(`${user.id}/`)) {
      return fail("That image does not belong to you.", 403);
    }
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return fail(
      "Photo scanning is not configured yet. Enter the details manually.",
      503
    );
  }

  const images: { base64: string; mimeType: string }[] = [];
  for (const path of paths) {
    const blob = await downloadImage(admin, path);
    if (!blob) {
      return fail("We could not read the uploaded photo. Please try again.", 502);
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    images.push({
      base64: buffer.toString("base64"),
      mimeType: blob.type || "image/jpeg",
    });
  }

  // allSettled never throws: each image either yields an extraction (value) or
  // an error we classify below. null value = model could not read the photo.
  const settled = await Promise.allSettled(
    images.map((image) =>
      extractMedicineFromImage({ ...image, mode: mode as ScanMode })
    )
  );

  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[api/extract] extraction failed", result.reason);
    }
  }

  const extractions: (MedicineExtraction | null)[] = settled.map((result) =>
    result.status === "fulfilled" ? result.value : null
  );

  const rejected = settled.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );

  if (rejected.some((result) => result.reason instanceof GeminiConfigError)) {
    return fail(
      "Photo scanning is not configured yet. Enter the details manually.",
      503
    );
  }

  // At least one image was genuinely unreadable by the model vs the scanner
  // being temporarily unavailable — those need different messages.
  const transient =
    rejected.length > 0 &&
    rejected.every((result) => result.reason instanceof GeminiRequestError);
  const unreadable = "We could not read this photo clearly. Try a sharper photo or enter it manually.";
  const busy = "The scanner is busy right now. Please try again in a moment.";

  // Two images (strip + box) are returned per image for later cross-checking.
  if (paths.length === 2) {
    const [strip, box] = extractions;
    if (!strip && !box) return fail(transient ? busy : unreadable, transient ? 503 : 422);
    return NextResponse.json({ strip: strip ?? null, box: box ?? null });
  }

  const single = extractions[0];
  if (!single) return fail(transient ? busy : unreadable, transient ? 503 : 422);
  return NextResponse.json(single);
}
