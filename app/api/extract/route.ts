import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  callGemini,
  GeminiAllFailedError,
  GeminiConfigError,
  GeminiRequestError,
} from "@/lib/gemini";
import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_INSTRUCTION,
  SCAN_MODES,
  buildUserPrompt,
  parseExtractionJson,
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

  // allSettled never throws: each image either yields a { data, model_used }
  // result or an error we classify below. The model used is returned in the
  // response (never shown in UI text) so the reader is traceable.
  const settled = await Promise.allSettled(
    images.map((image) =>
      callGemini<MedicineExtraction>({
        kind: "scan",
        prompt: buildUserPrompt(mode as ScanMode),
        systemInstruction: SYSTEM_INSTRUCTION,
        images: [image],
        responseSchema: EXTRACTION_JSON_SCHEMA,
        parse: parseExtractionJson,
      })
    )
  );

  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[api/extract] extraction failed", result.reason);
    }
  }

  const extractions: (MedicineExtraction | null)[] = settled.map((result) =>
    result.status === "fulfilled" ? result.value.data : null
  );
  const modelsUsed: (string | null)[] = settled.map((result) =>
    result.status === "fulfilled" ? result.value.model_used : null
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

  // A fatal status (400/401/403) is returned immediately - no fallback happened.
  const fatal = rejected.find(
    (result) => result.reason instanceof GeminiRequestError
  );
  if (fatal) {
    const status = (fatal.reason as GeminiRequestError).status;
    if (status === 401 || status === 403) {
      return fail(
        "Photo scanning is not configured yet. Enter the details manually.",
        503
      );
    }
    return fail(
      "The scanner had a problem. Please try again or enter details manually.",
      502
    );
  }

  // Every model in the chain failed for at least one photo: friendly message.
  const allFailed = rejected.some(
    (result) => result.reason instanceof GeminiAllFailedError
  );
  const message = allFailed
    ? "Daily limit reached. Please try again later or enter details manually."
    : "We could not read this photo clearly. Try a sharper photo or enter it manually.";
  const status = allFailed ? 503 : 422;

  // Two images (strip + box) are returned per image for later cross-checking.
  if (paths.length === 2) {
    const [strip, box] = extractions;
    if (!strip && !box) return fail(message, status);
    return NextResponse.json({
      strip: strip ?? null,
      box: box ?? null,
      model_used: { strip: modelsUsed[0] ?? null, box: modelsUsed[1] ?? null },
    });
  }

  const single = extractions[0];
  if (!single) return fail(message, status);
  return NextResponse.json({ ...single, model_used: modelsUsed[0] ?? null });
}
