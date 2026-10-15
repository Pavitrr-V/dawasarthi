import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { GeminiConfigError, extractMedicineFromImage } from "@/lib/gemini";
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
    const { data, error } = await admin.storage
      .from(MEDICINE_IMAGES_BUCKET)
      .download(path);
    if (error || !data) {
      return fail("We could not read the uploaded photo. Please try again.");
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    images.push({
      base64: buffer.toString("base64"),
      mimeType: data.type || "image/jpeg",
    });
  }

  let extractions: (MedicineExtraction | null)[];
  try {
    const settled = await Promise.allSettled(
      images.map((image) =>
        extractMedicineFromImage({ ...image, mode: mode as ScanMode })
      )
    );
    extractions = settled.map((result) =>
      result.status === "fulfilled" ? result.value : null
    );

    if (
      settled.every((result) => result.status === "rejected") &&
      settled.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof GeminiConfigError
      )
    ) {
      return fail(
        "Photo scanning is not configured yet. Enter the details manually.",
        503
      );
    }
  } catch {
    return fail("The scanner is busy right now. Please try again.", 502);
  }

  // Two images (strip + box) are returned per image for later cross-checking.
  if (paths.length === 2) {
    const [strip, box] = extractions;
    if (!strip && !box) {
      return fail(
        "We could not read these photos clearly. Try a sharper photo or enter it manually.",
        422
      );
    }
    return NextResponse.json({ strip: strip ?? null, box: box ?? null });
  }

  const single = extractions[0];
  if (!single) {
    return fail(
      "We could not read this photo clearly. Try a sharper photo or enter it manually.",
      422
    );
  }
  return NextResponse.json(single);
}
