import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

function jsonResponse(body: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

function errorResponse(
  status: number,
  statusText = "",
  textBody = ""
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    text: async () => textBody,
    json: async () => ({}),
    headers: new Headers(),
  };
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODELS;
  delete process.env.GEMINI_SCAN_MODELS;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

function mockFetchQueue(responses: Partial<Response>[]) {
  const queue = responses.slice();
  global.fetch = vi.fn(
    () =>
      queue.shift() ??
      Promise.reject(new Error("no more mocked responses"))
  ) as unknown as typeof global.fetch;
}

function okJson(text: string): Partial<Response> {
  return jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });
}

const noopParse = (text: string) => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const objSchema = { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } } };

describe("callGemini model fallback", () => {
  it("first model returns 429, second returns 200 -> result comes from the second", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODELS = "m1,m2";

    mockFetchQueue([
      errorResponse(429, "Too Many Requests", "rate limited"),
      okJson(JSON.stringify({ ok: true })),
    ]);

    const { callGemini } = await import("../gemini");
    const result = await callGemini({
      kind: "text",
      prompt: "test prompt",
      responseSchema: objSchema,
      parse: noopParse,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.model_used).toBe("m2");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT fall back on 403 (no second call)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODELS = "m1,m2";

    const fetchMock = vi.fn(() =>
      Promise.resolve(
        errorResponse(403, "Forbidden", "forbidden") as Response
      )
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const { callGemini } = await import("../gemini");

    await expect(
      callGemini({
        kind: "text",
        prompt: "test prompt",
        responseSchema: objSchema,
        parse: noopParse,
      })
    ).rejects.toThrow(/403/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the friendly error when all models fail", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODELS = "m1,m2";

    mockFetchQueue([
      errorResponse(429, "Too Many Requests", "rate limited"),
      errorResponse(500, "Internal Server Error", "boom"),
    ]);

    const { callGemini } = await import("../gemini");

    await expect(
      callGemini({
        kind: "text",
        prompt: "test prompt",
        responseSchema: objSchema,
        parse: noopParse,
      })
    ).rejects.toThrow(
      "Daily limit reached. Please try again later or enter details manually."
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses GEMINI_SCAN_MODELS for kind 'scan' and GEMINI_MODELS for kind 'text'", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODELS = "text-a,text-b";
    process.env.GEMINI_SCAN_MODELS = "scan-a, scan-b ,";

    mockFetchQueue([
      errorResponse(429),
      okJson(JSON.stringify({ ok: true })),
      okJson(JSON.stringify({ ok: true })),
    ]);

    const { callGemini } = await import("../gemini");

    const scan = await callGemini({
      kind: "scan",
      prompt: "p",
      responseSchema: objSchema,
      parse: noopParse,
    });
    expect(scan.model_used).toBe("scan-b");

    const text = await callGemini({
      kind: "text",
      prompt: "p",
      responseSchema: objSchema,
      parse: noopParse,
    });
    expect(text.model_used).toBe("text-a");
  });

  it("falls back to the next model once on invalid JSON (not the same model)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODELS = "m1,m2";

    mockFetchQueue([
      okJson("this is not json"),
      okJson(JSON.stringify({ ok: true })),
    ]);

    const { callGemini } = await import("../gemini");
    const result = await callGemini({
      kind: "text",
      prompt: "p",
      responseSchema: objSchema,
      parse: noopParse,
    });

    expect(result.model_used).toBe("m2");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
