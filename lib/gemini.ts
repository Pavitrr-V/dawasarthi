/** Per-model HTTP timeout. Each model in the fallback chain gets this budget. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Shown to the user when every model in the chain fails. */
export const GEMINI_FRIENDLY_ERROR =
  "Daily limit reached. Please try again later or enter details manually.";

/**
 * The only statuses that move to the next model. A 20s timeout also moves on.
 * Everything else (notably 400, 401 and 403) is returned immediately.
 */
const FALLBACK_STATUSES = new Set([404, 429, 500, 503]);

const DEFAULT_MODEL = "gemini-3.1-flash-lite";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Missing/blank configuration (no API key). */
export class GeminiConfigError extends Error {}

/** A single model returned a fatal (non-fallback) HTTP status. */
export class GeminiRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
  }
}

/** Every model in the chain was tried and none produced a usable answer. */
export class GeminiAllFailedError extends Error {
  constructor() {
    super(GEMINI_FRIENDLY_ERROR);
    this.name = "GeminiAllFailedError";
  }
}

export type GeminiImage = {
  base64: string;
  mimeType: string;
};

export type CallGeminiResult<T> = {
  data: T;
  model_used: string;
};

export type CallGeminiArgs<T> = {
  /** "scan" prefers GEMINI_SCAN_MODELS, "text" uses GEMINI_MODELS. */
  kind: "scan" | "text";
  prompt: string;
  systemInstruction?: string;
  images?: GeminiImage[];
  responseSchema: unknown;
  /** Must return null for anything it does not accept, never throw. */
  parse: (text: string) => T | null;
};

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

function parseModelList(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

/** Ordered model list for a call. Always non-empty. */
function getModelList(kind: "scan" | "text"): string[] {
  let models: string[] = [];

  if (kind === "scan") {
    models = parseModelList(process.env.GEMINI_SCAN_MODELS);
    if (models.length === 0) models = parseModelList(process.env.GEMINI_MODELS);
  } else {
    models = parseModelList(process.env.GEMINI_MODELS);
  }

  return models.length > 0 ? models : [DEFAULT_MODEL];
}

function normalizeMime(mimeType: string): string {
  const lower = (mimeType || "").toLowerCase().split(";")[0].trim();
  return ALLOWED_MIME.has(lower) ? lower : "image/jpeg";
}

/**
 * The one place Gemini is called. Tries each configured model in order and
 * returns the first usable, schema-valid answer.
 *
 * Fallback rules:
 *  - Move to the next model only on HTTP 404/429/500/503 or a 20s timeout.
 *  - 400/401/403 (and any other status) is thrown immediately as a
 *    GeminiRequestError.
 *  - Invalid JSON / zod failure retries ONCE on the next model, then gives up.
 *  - If every model fails, a GeminiAllFailedError with the friendly message.
 *
 * The API key and image bytes are never logged.
 */
export async function callGemini<T>({
  kind,
  prompt,
  systemInstruction,
  images,
  responseSchema,
  parse,
}: CallGeminiArgs<T>): Promise<CallGeminiResult<T>> {
  const apiKey = resolveApiKey();
  const models = getModelList(kind);

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of images ?? []) {
    parts.push({
      inlineData: {
        mimeType: normalizeMime(image.mimeType),
        data: image.base64,
      },
    });
  }

  let validationRetried = false;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const isLast = i === models.length - 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            ...(systemInstruction
              ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
              : {}),
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema,
            },
          }),
          signal: controller.signal,
        }
      );
    } catch (error) {
      clearTimeout(timeout);
      const aborted = error instanceof Error && error.name === "AbortError";
      console.warn(
        `[gemini] model ${model} ${aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : "network error"}; trying next`
      );
      if (isLast) break;
      continue;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      const detail = (await response.text().catch(() => "")).slice(0, 200);

      if (!FALLBACK_STATUSES.has(status)) {
        console.warn(
          `[gemini] model ${model} failed with fatal status ${status}; not falling back`
        );
        throw new GeminiRequestError(
          `Gemini ${status}: ${detail || response.statusText}`,
          status
        );
      }

      console.warn(`[gemini] model ${model} failed with status ${status}; trying next`);
      if (isLast) break;
      continue;
    }

    const payload = (await response.json().catch(() => null)) as {
      promptFeedback?: { blockReason?: string };
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    } | null;

    if (!payload) {
      console.warn(`[gemini] model ${model} returned an unreadable body; trying next`);
      if (isLast) break;
      continue;
    }

    if (payload.promptFeedback?.blockReason) {
      console.warn(
        `[gemini] model ${model} blocked the prompt (${payload.promptFeedback.blockReason}); trying next`
      );
      if (isLast) break;
      continue;
    }

    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (text.length === 0) {
      console.warn(`[gemini] model ${model} returned an empty response; trying next`);
      if (isLast) break;
      continue;
    }

    const parsed = parse(text);
    if (parsed !== null) {
      console.warn(`[gemini] model ${model} answered successfully`);
      return { data: parsed, model_used: model };
    }

    // Invalid JSON or failed zod validation: retry ONCE on the next model.
    if (!validationRetried && !isLast) {
      validationRetried = true;
      console.warn(
        `[gemini] model ${model} returned invalid output; retrying once on the next model`
      );
      continue;
    }
    console.warn(`[gemini] model ${model} returned invalid output; no retries left`);
    break;
  }

  throw new GeminiAllFailedError();
}
