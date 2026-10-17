import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/twilio";

describe("normalizePhone", () => {
  it("keeps an explicit country code and strips separators", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("+1 (415) 555-0123")).toBe("+14155550123");
  });

  it("assumes India (+91) for a bare 10-digit number", () => {
    expect(normalizePhone("9876543210")).toBe("+919876543210");
    expect(normalizePhone("98765-43210")).toBe("+919876543210");
  });

  it("accepts a bare 91-prefixed 12-digit number", () => {
    expect(normalizePhone("919876543210")).toBe("+919876543210");
  });

  it("returns null when there is nothing usable", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("not a number")).toBeNull();
  });
});
