import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const adminState = vi.hoisted(() => ({
  count: 0,
  error: null as null | { message: string },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: () => ({
          gte: async () => ({ count: adminState.count, error: adminState.error }),
        }),
      }),
    }),
  }),
}));

function jsonResponse(body: unknown, status = 200): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

function errorResponse(
  status: number,
  textBody = ""
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText: "",
    text: async () => textBody,
    json: async () => ({}),
    headers: new Headers(),
  };
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = { ...originalEnv };
  delete process.env.TINYFISH_API_KEY;
  delete process.env.TINYFISH_ENABLED;
  delete process.env.TINYFISH_DAILY_CAP;
  adminState.count = 0;
  adminState.error = null;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

function mockFetchQueue(responses: Partial<Response>[]) {
  const queue = responses.slice();
  const fn = vi.fn(
    () =>
      queue.shift() ?? Promise.reject(new Error("no more mocked responses"))
  );
  global.fetch = fn as unknown as typeof global.fetch;
  return fn;
}

const validKeyEnv = () => {
  process.env.TINYFISH_API_KEY = "test-key";
};

describe("searchWeb", () => {
  it("maps results and sends the key as X-API-Key", async () => {
    validKeyEnv();
    const fetchMock = mockFetchQueue([
      jsonResponse({
        query: "paracetamol",
        results: [
          { position: 1, title: "A", url: "https://a.test", snippet: "sa" },
          { position: 2, title: "B", url: "", snippet: "sb" },
        ],
      }),
    ]);

    const { searchWeb } = await import("@/lib/tinyfish");
    const results = await searchWeb("paracetamol");

    expect(results).toEqual([
      { title: "A", url: "https://a.test", snippet: "sa" },
    ]);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain("query=paracetamol");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("test-key");
  });

  it("throws RateLimitError on 429 and does not retry", async () => {
    validKeyEnv();
    const fetchMock = mockFetchQueue([errorResponse(429, "slow down")]);

    const { searchWeb, RateLimitError } = await import("@/lib/tinyfish");
    await expect(searchWeb("q")).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws AuthError on 401 and does not retry", async () => {
    validKeyEnv();
    const fetchMock = mockFetchQueue([errorResponse(401, "nope")]);

    const { searchWeb, AuthError } = await import("@/lib/tinyfish");
    await expect(searchWeb("q")).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on 500 then succeeds", async () => {
    validKeyEnv();
    const fetchMock = mockFetchQueue([
      errorResponse(500, "boom"),
      jsonResponse({ results: [{ title: "A", url: "https://a.test" }] }),
    ]);

    const { searchWeb } = await import("@/lib/tinyfish");
    const results = await searchWeb("q");

    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws ConfigError when the key is missing", async () => {
    const fetchMock = mockFetchQueue([]);
    const { searchWeb, ConfigError } = await import("@/lib/tinyfish");

    await expect(searchWeb("q")).rejects.toBeInstanceOf(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchPage", () => {
  it("returns the first result's text, title and final url", async () => {
    validKeyEnv();
    mockFetchQueue([
      jsonResponse({
        results: [
          {
            url: "https://a.test",
            final_url: "https://a.test/final",
            title: "A",
            text: "hello world",
          },
        ],
        errors: [],
      }),
    ]);

    const { fetchPage } = await import("@/lib/tinyfish");
    const page = await fetchPage("https://a.test");

    expect(page).toEqual({
      url: "https://a.test/final",
      text: "hello world",
      title: "A",
    });
  });

  it("throws UpstreamError when the page could not be fetched", async () => {
    validKeyEnv();
    mockFetchQueue([
      jsonResponse({
        results: [],
        errors: [{ url: "https://a.test", error: "blocked" }],
      }),
    ]);

    const { fetchPage, UpstreamError } = await import("@/lib/tinyfish");
    await expect(fetchPage("https://a.test")).rejects.toBeInstanceOf(
      UpstreamError
    );
  });
});

describe("getAgentRun", () => {
  it.each([
    ["PENDING", "running"],
    ["RUNNING", "running"],
    ["COMPLETED", "done"],
    ["FAILED", "failed"],
    ["CANCELLED", "failed"],
  ])("maps %s to %s", async (raw, expected) => {
    validKeyEnv();
    mockFetchQueue([
      jsonResponse({ run_id: "r1", status: raw, result: { ok: true } }),
    ]);

    const { getAgentRun } = await import("@/lib/tinyfish");
    const run = await getAgentRun("r1");

    expect(run.status).toBe(expected);
  });

  it("extracts the message from the run's error object", async () => {
    validKeyEnv();
    mockFetchQueue([
      jsonResponse({
        status: "FAILED",
        result: null,
        error: { code: "TIMEOUT", message: "timed out" },
      }),
    ]);

    const { getAgentRun } = await import("@/lib/tinyfish");
    const run = await getAgentRun("r1");

    expect(run.status).toBe("failed");
    expect(run.error).toBe("timed out");
  });

  it("throws UpstreamError on an unknown status", async () => {
    validKeyEnv();
    mockFetchQueue([jsonResponse({ status: "WEIRD" })]);

    const { getAgentRun, UpstreamError } = await import("@/lib/tinyfish");
    await expect(getAgentRun("r1")).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("startAgentRun", () => {
  it("appends the untrusted-page guard, posts to run-async, returns the run id", async () => {
    validKeyEnv();
    adminState.count = 0;
    const fetchMock = mockFetchQueue([jsonResponse({ run_id: "run-123" })]);

    const { startAgentRun, UNTRUSTED_PAGE_GUARD } = await import(
      "@/lib/tinyfish"
    );
    const handle = await startAgentRun({
      url: "https://shop.test/p",
      goal: "Find the price",
    });

    expect(handle.runId).toBe("run-123");
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain("/v1/automation/run-async");
    const body = JSON.parse(init.body as string);
    expect(body.url).toBe("https://shop.test/p");
    expect(body.goal).toContain("Find the price");
    expect(body.goal).toContain(UNTRUSTED_PAGE_GUARD);
  });

  it("throws BudgetExceeded when TinyFish is disabled (no fetch)", async () => {
    validKeyEnv();
    process.env.TINYFISH_ENABLED = "false";
    const fetchMock = mockFetchQueue([]);

    const { startAgentRun, BudgetExceeded } = await import("@/lib/tinyfish");
    await expect(
      startAgentRun({ url: "https://a.test", goal: "g" })
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws BudgetExceeded when today's job count is at the cap (no fetch)", async () => {
    validKeyEnv();
    process.env.TINYFISH_DAILY_CAP = "3";
    adminState.count = 3;
    const fetchMock = mockFetchQueue([]);

    const { startAgentRun, BudgetExceeded } = await import("@/lib/tinyfish");
    await expect(
      startAgentRun({ url: "https://a.test", goal: "g" })
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a run when today's count is under the cap", async () => {
    validKeyEnv();
    process.env.TINYFISH_DAILY_CAP = "3";
    adminState.count = 2;
    const fetchMock = mockFetchQueue([jsonResponse({ run_id: "ok" })]);

    const { startAgentRun } = await import("@/lib/tinyfish");
    const handle = await startAgentRun({ url: "https://a.test", goal: "g" });

    expect(handle.runId).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws UpstreamError when run-async returns no run id", async () => {
    validKeyEnv();
    mockFetchQueue([jsonResponse({ error: "bad url" })]);

    const { startAgentRun, UpstreamError } = await import("@/lib/tinyfish");
    await expect(
      startAgentRun({ url: "https://a.test", goal: "g" })
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("buildGoal", () => {
  it("appends the guard to a non-empty goal", async () => {
    const { buildGoal, UNTRUSTED_PAGE_GUARD } = await import("@/lib/tinyfish");
    const goal = buildGoal("Do the thing");
    expect(goal.startsWith("Do the thing")).toBe(true);
    expect(goal).toContain(UNTRUSTED_PAGE_GUARD);
  });

  it("returns just the guard for an empty goal", async () => {
    const { buildGoal, UNTRUSTED_PAGE_GUARD } = await import("@/lib/tinyfish");
    expect(buildGoal("   ")).toBe(UNTRUSTED_PAGE_GUARD);
  });
});
