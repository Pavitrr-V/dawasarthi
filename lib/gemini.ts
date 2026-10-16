import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildUserPrompt,
  parseExtractionJson,
  type MedicineExtraction,
  type ScanMode,
} from "@/lib/extraction";

const DEFAULT_MODEL = "gemini-3.8-flash";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const OVERALL_BUDGET_MS = 40_000;
const MAX_BACKOFF_MS = 8_000;

// Transient statuses worth retrying. 400/401/403/404 are not retryable.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export class GeminiConfigError extends Error {}

export class GeminiRequestError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number | null,
    retryable: boolean,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

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

/** The model the LLM calls will use. Read from GEMINI_MODEL server-side only. */
export function resolveGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

function normalizeMime(mimeType: string): string {
  const lower = (mimeType || "").toLowerCase().split(";")[0].trim();
  return ALLOWED_MIME.has(lower) ? lower : "image/jpeg";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, capped so we stay inside the budget. */
function backoffMs(attempt: number, retryAfterMs?: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, 400 * 2 ** (attempt - 1));
  const base = Math.max(exponential, retryAfterMs ?? 0);
  return Math.min(MAX_BACKOFF_MS, base) + Math.floor(Math.random() * 250);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function toGeminiRequestError(error: unknown): GeminiRequestError {
  if (error instanceof GeminiRequestError) return error;
  return new GeminiRequestError(
    error instanceof Error ? error.message : "network error",
    null,
    true
  );
}

type GeminiImage = { base64: string; mimeType: string };

/**
 * Generic structured-output call to Gemini Flash.
 *
 * Retries transient failures (429/5xx/network/timeout) AND output the parser
 * rejects, with exponential backoff. Returns null only when the model
 * genuinely answered with something `parse` cannot accept. Throws
 * GeminiRequestError when the API stayed unavailable and GeminiConfigError
 * when the key is missing.
 *
 * `parse` must return null for anything it does not accept, and must not
 * throw for a bad-but-parseable response.
 */
export async function generateJson<T>({
  systemInstruction,
  userPrompt,
  responseSchema,
  parse,
  image,
}: {
  systemInstruction: string;
  userPrompt: string;
  responseSchema: unknown;
  parse: (text: string) => T | null;
  image?: GeminiImage;
}): Promise<T | null> {
  const apiKey = resolveApiKey();
  const model = resolveGeminiModel();
  const startedAt = Date.now();

  let lastError: GeminiRequestError | null = null;
  let lastRetryAfterMs: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const text = await postGenerateContent({
        apiKey,
        model,
        systemInstruction,
        parts: [
          { text: userPrompt },
          ...(image
            ? [
                {
                  inlineData: {
                    mimeType: normalizeMime(image.mimeType),
                    data: image.base64,
                  },
                },
              ]
            : []),
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema,
        },
      });

      if (text !== null) {
        const parsed = parse(text);
        if (parsed !== null) return parsed;
        console.warn(`[gemini] unparseable JSON (attempt ${attempt})`);
      } else {
        console.warn(`[gemini] empty response (attempt ${attempt})`);
      }
    } catch (error) {
      const geminiError = toGeminiRequestError(error);
      lastError = geminiError;
      lastRetryAfterMs = geminiError.retryAfterMs;

      if (!geminiError.retryable) throw geminiError;

      console.warn(
        `[gemini] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${geminiError.message}`
      );
    }

    const outOfTime = Date.now() - startedAt > OVERALL_BUDGET_MS;
    if (attempt < MAX_ATTEMPTS && !outOfTime) {
      await sleep(backoffMs(attempt, lastRetryAfterMs));
      lastRetryAfterMs = undefined;
    } else {
      break;
    }
  }

  // A transport/API error is more important to surface than "unreadable".
  if (lastError) throw lastError;
  return null;
}

/**
 * Send one image to Gemini Flash and return the structured medicine
 * extraction. Kept as a thin wrapper so /api/extract is unchanged.
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
  return generateJson<MedicineExtraction>({
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt: buildUserPrompt(mode),
    responseSchema: EXTRACTION_JSON_SCHEMA,
    parse: parseExtractionJson,
    image: { base64, mimeType },
  });
}

async function postGenerateContent({
  apiKey,
  model,
  systemInstruction,
  parts,
  generationConfig,
}: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  parts: unknown[];
  generationConfig: Record<string, unknown>;
}): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new GeminiRequestError(
      aborted ? "Gemini request timed out" : "Gemini network error",
      null,
      true
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    const retryable = RETRYABLE_STATUS.has(response.status);
    throw new GeminiRequestError(
      `Gemini ${response.status}: ${detail || response.statusText}`,
      response.status,
      retryable,
      parseRetryAfter(response.headers.get("retry-after"))
    );
  }

  const payload = (await response.json()) as {
    promptFeedback?: { blockReason?: string };
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  if (payload.promptFeedback?.blockReason) return null;

  const partsOut = payload.candidates?.[0]?.content?.parts ?? [];
  const text = partsOut
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return text.length > 0 ? text : null;
}
