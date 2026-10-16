import { afterEach, describe, expect, it, vi } from "vitest";

// lib/verify.ts pulls in the service-role client and the shared recompute
// helper. Both are only used at runtime (DB paths we do not exercise here), so
// mocking them keeps the pure logic testable without Supabase env vars.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({}) }),
}));
vi.mock("@/lib/risk-recompute", () => ({
  recomputeMedicineRiskWith: vi.fn(),
}));

import {
  MAX_FIELD_LEN,
  VERIFY_FRESH_MS,
  VERIFY_MAX_PER_HOUR,
  hourlyLimitReached,
  isFresh,
  parseVerifyResult,
  sameProduct,
  verifyGoal,
  verifySearchUrl,
  verifySources,
} from "@/lib/verify";

const originalSourceUrls = process.env.VERIFY_SOURCE_URLS;

afterEach(() => {
  if (originalSourceUrls === undefined) delete process.env.VERIFY_SOURCE_URLS;
  else process.env.VERIFY_SOURCE_URLS = originalSourceUrls;
});

describe("verifySources", () => {
  it("derives host names and caps the list at two", () => {
    process.env.VERIFY_SOURCE_URLS =
      "https://www.1mg.com/search/all?name={query}," +
      "https://pharmeasy.in/search/all?name={query}," +
      "https://third.example/x?q={query}";

    const sources = verifySources();
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      site: "1mg.com",
      url: "https://www.1mg.com/search/all?name={query}",
    });
    expect(sources[1].site).toBe("pharmeasy.in");
  });

  it("returns an empty list when unset", () => {
    delete process.env.VERIFY_SOURCE_URLS;
    expect(verifySources()).toEqual([]);
  });

  it("drops invalid patterns and duplicate hosts", () => {
    process.env.VERIFY_SOURCE_URLS =
      "not-a-url,https://www.1mg.com/a?q={query},https://1mg.com/b?q={query}";
    const sources = verifySources();
    expect(sources).toHaveLength(1);
    expect(sources[0].site).toBe("1mg.com");
  });
});

describe("verifySearchUrl", () => {
  it("encodes the medicine name into the {query} placeholder", () => {
    expect(verifySearchUrl("https://x.example/s?name={query}", "Crocin 500")).toBe(
      "https://x.example/s?name=Crocin%20500"
    );
  });
});

describe("verifyGoal", () => {
  it("includes the medicine's own printed fields", () => {
    const goal = verifyGoal({
      name: "Crocin",
      composition: ["Paracetamol"],
      manufacturer: "GSK",
    });
    expect(goal).toContain("Crocin");
    expect(goal).toContain("Paracetamol");
    expect(goal).toContain("GSK");
  });

  it("never leaks patient information", () => {
    const goal = verifyGoal({ name: "Crocin", composition: null, manufacturer: null });
    expect(goal).not.toMatch(/patient|allerg|asthma|ramesh|\bage\b/i);
  });
});

describe("parseVerifyResult", () => {
  it("maps a found result", () => {
    const parsed = parseVerifyResult({
      found: true,
      listed_name: "Crocin",
      listed_mrp: 45.5,
      listed_manufacturer: "GSK",
      listed_pack_size: "10 tablets",
      confidence: 0.9,
    });
    expect(parsed).toEqual({
      status: "found",
      facts: {
        listed_name: "Crocin",
        listed_mrp: 45.5,
        listed_manufacturer: "GSK",
        listed_pack_size: "10 tablets",
        confidence: 0.9,
      },
    });
  });

  it("maps found:false and empty objects to not_found", () => {
    expect(parseVerifyResult({ found: false })).toEqual({ status: "not_found" });
    expect(parseVerifyResult({})).toEqual({ status: "not_found" });
  });

  it("maps unreadable payloads to error", () => {
    expect(parseVerifyResult("not json").status).toBe("error");
    expect(parseVerifyResult(null).status).toBe("error");
  });

  it("accepts a JSON string result", () => {
    expect(
      parseVerifyResult(JSON.stringify({ found: true, listed_name: "Crocin" })).status
    ).toBe("found");
  });

  it("drops an out-of-bounds MRP instead of trusting it", () => {
    for (const mrp of [0, -5, 100000, 99_999_999, "abc", null]) {
      const parsed = parseVerifyResult({
        found: true,
        listed_name: "X",
        listed_mrp: mrp,
      });
      if (parsed.status !== "found") throw new Error("expected found");
      expect(parsed.facts.listed_mrp).toBeNull();
    }
  });

  it("keeps a valid MRP, rounded to paise", () => {
    const parsed = parseVerifyResult({
      found: true,
      listed_name: "X",
      listed_mrp: "45.567",
    });
    if (parsed.status !== "found") throw new Error("expected found");
    expect(parsed.facts.listed_mrp).toBe(45.57);
  });

  it("drops an out-of-range confidence", () => {
    for (const confidence of [-1, 1.5, "abc"]) {
      const parsed = parseVerifyResult({ found: true, listed_name: "X", confidence });
      if (parsed.status !== "found") throw new Error("expected found");
      expect(parsed.facts.confidence).toBeNull();
    }
  });

  it("trims over-long strings to MAX_FIELD_LEN", () => {
    const parsed = parseVerifyResult({
      found: true,
      listed_name: "a".repeat(500),
    });
    if (parsed.status !== "found") throw new Error("expected found");
    expect(parsed.facts.listed_name).toHaveLength(MAX_FIELD_LEN);
  });
});

describe("24h cache", () => {
  const now = new Date("2026-01-02T12:00:00Z");

  it("isFresh is true within 24h and false outside (or unknown)", () => {
    expect(isFresh(new Date(now.getTime() - 1000).toISOString(), now)).toBe(true);
    expect(
      isFresh(new Date(now.getTime() - VERIFY_FRESH_MS - 1000).toISOString(), now)
    ).toBe(false);
    expect(isFresh(null, now)).toBe(false);
  });

  it("sameProduct matches on normalised name and batch", () => {
    expect(
      sameProduct(
        { name: "Crocin 500", batch_no: "CT-503513C" },
        { name: "crocin 500", batch_no: "CT503513C" }
      )
    ).toBe(true);
    expect(
      sameProduct({ name: "Crocin", batch_no: "A" }, { name: "Crocin", batch_no: "B" })
    ).toBe(false);
    expect(sameProduct({ name: "", batch_no: null }, { name: "", batch_no: null })).toBe(
      false
    );
  });
});

describe("per-user hourly limit", () => {
  it("is reached at the cap, not below it", () => {
    expect(hourlyLimitReached(VERIFY_MAX_PER_HOUR - 1)).toBe(false);
    expect(hourlyLimitReached(VERIFY_MAX_PER_HOUR)).toBe(true);
  });
});
