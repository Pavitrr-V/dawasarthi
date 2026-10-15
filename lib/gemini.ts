import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildUserPrompt,
  parseExtractionJson,
  type MedicineExtraction,
  type ScanMode,
} from "@/lib/extraction";

const DEFAULT_MODEL = "gemini-3.8-flash";
const REQUEST_TIMEOUT_MS = 45_000;

export class GeminiConfigError extends Error {}

function resolveApiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new GeminiConfigError(
      "Missing GEMINI_API_KEY. Add it to .env.local (server-only)."
    );
  }
  return key;
}

function resolveModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Send one image to Gemini Flash and return the structured extraction.
 * Retries once when the model returns something zod cannot validate.
 */
export async function extractMedicineFromImage({
  base64,
  mimeType,
  mode,
}: {
  base64: string;
  mimeType: string;
  mode: ScanMode;
}): Promise<MedicineExtraction | null> {
  const apiKey = resolveApiKey();
  const model = resolveModel();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await callGemini({ apiKey, model, base64, mimeType, mode });
    if (text === null) continue;
    const parsed = parseExtractionJson(text);
    if (parsed) return parsed;
  }

  return null;
}

async function callGemini({
  apiKey,
  model,
  base64,
  mimeType,
  mode,
}: {
  apiKey: string;
  model: string;
  base64: string;
  mimeType: string;
  mode: ScanMode;
}): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: buildUserPrompt(mode) },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: EXTRACTION_JSON_SCHEMA,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      promptFeedback?: { blockReason?: string };
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    if (payload.promptFeedback?.blockReason) return null;

    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  } finally {
    clearTimeout(timeout);
  }
}
