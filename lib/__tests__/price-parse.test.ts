import { describe, expect, it } from "vitest";
import { parsePriceResult } from "@/lib/price-parse";

describe("parsePriceResult", () => {
  it("keeps well-formed quotes and derives the site from the URL", () => {
    const quotes = parsePriceResult({
      quotes: [
        {
          source_site: "1mg",
          source_url: "https://www.1mg.com/drugs/paracetamol-500mg-123",
          price: 24.5,
          pack_size: "strip of 10",
          in_stock: true,
        },
        {
          source_url: "https://pharmeasy.in/online-medicine-order/paracetamol",
          price: "30",
          in_stock: "out of stock",
        },
      ],
    });

    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toEqual({
      source_site: "1mg",
      source_url: "https://www.1mg.com/drugs/paracetamol-500mg-123",
      price: 24.5,
      pack_size: "strip of 10",
      in_stock: true,
    });
    // No source_site given -> use the hostname, and parse a string price.
    expect(quotes[1].source_site).toBe("pharmeasy.in");
    expect(quotes[1].price).toBe(30);
    expect(quotes[1].in_stock).toBe(false);
  });

  it("accepts the payload as a JSON string", () => {
    const quotes = parsePriceResult(
      JSON.stringify({ quotes: [{ source_url: "https://x.test/a", price: 5 }] })
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0].source_site).toBe("x.test");
  });

  it("drops malformed, negative, and missing-URL quotes", () => {
    const quotes = parsePriceResult({
      quotes: [
        { source_url: "", price: 10 },
        { source_url: "https://x.test/a", price: -1 },
        { source_url: "https://x.test/b", price: "free" },
        { source_url: "https://x.test/c", price: 9999999 },
        null,
        "nope",
      ],
    });
    expect(quotes).toEqual([]);
  });

  it("returns an empty array for unreadable payloads", () => {
    expect(parsePriceResult(null)).toEqual([]);
    expect(parsePriceResult("not json")).toEqual([]);
    expect(parsePriceResult({ nope: true })).toEqual([]);
    expect(parsePriceResult([{ source_url: "https://x.test/a", price: 1 }])).toEqual([]);
  });
});
