import { describe, expect, it } from "vitest";
import { nameHintFromScan, parseGs1 } from "./gs1";

describe("parseGs1 with parentheses", () => {
  it("reads GTIN, expiry, batch and serial", () => {
    const result = parseGs1(
      "(01)08901234567890(17)271231(10)ABC123(21)SN98765"
    );
    expect(result.isGs1).toBe(true);
    expect(result.gtin).toBe("08901234567890");
    expect(result.batch).toBe("ABC123");
    expect(result.expiry).toBe("2027-12-31");
    expect(result.expiryPrecision).toBe("day");
    expect(result.serial).toBe("SN98765");
  });

  it("normalises a month-level expiry (day 00) to the 1st", () => {
    const result = parseGs1("(01)08901234567890(17)270100");
    expect(result.expiry).toBe("2027-01-01");
    expect(result.expiryPrecision).toBe("month");
  });

  it("maps the 50-99 year range to the 1900s", () => {
    expect(parseGs1("(17)991231").expiry).toBe("1999-12-31");
  });

  it("ignores an invalid expiry month", () => {
    const result = parseGs1("(17)271331");
    expect(result.expiry).toBeNull();
    expect(result.fields["17"]).toEqual(["271331"]);
  });
});

describe("parseGs1 without parentheses", () => {
  it("reads a fixed-length identifier chain", () => {
    const result = parseGs1("010890123456789017271231");
    expect(result.isGs1).toBe(true);
    expect(result.gtin).toBe("08901234567890");
    expect(result.expiry).toBe("2027-12-31");
  });

  it("reads a trailing variable-length batch", () => {
    const result = parseGs1("01089012345678901727123110ABC123");
    expect(result.gtin).toBe("08901234567890");
    expect(result.batch).toBe("ABC123");
  });

  it("ends a variable-length field at the GS separator", () => {
    const result = parseGs1("0108901234567890\u001D10ABC123\u001D17271231");
    expect(result.gtin).toBe("08901234567890");
    expect(result.batch).toBe("ABC123");
    expect(result.expiry).toBe("2027-12-31");
  });
});

describe("parseGs1 plain retail barcodes", () => {
  it("treats an EAN-13 as a bare GTIN", () => {
    const result = parseGs1("8901234567890");
    expect(result.isGs1).toBe(false);
    expect(result.gtin).toBe("8901234567890");
    expect(result.batch).toBeNull();
    expect(result.expiry).toBeNull();
  });

  it("does not misread an EAN-13 that happens to start with 01", () => {
    const result = parseGs1("0108901234567");
    expect(result.isGs1).toBe(false);
    expect(result.gtin).toBe("0108901234567");
  });

  it("accepts a 14-digit GTIN", () => {
    expect(parseGs1("08901234567890").gtin).toBe("08901234567890");
  });
});

describe("parseGs1 garbage input", () => {
  it("returns an empty result", () => {
    const result = parseGs1("hello world");
    expect(result.isGs1).toBe(false);
    expect(result.gtin).toBeNull();
    expect(result.batch).toBeNull();
    expect(result.expiry).toBeNull();
    expect(result.serial).toBeNull();
  });

  it("handles empty input", () => {
    const result = parseGs1("");
    expect(result.raw).toBe("");
    expect(result.gtin).toBeNull();
  });
});

describe("nameHintFromScan", () => {
  it("extracts a name from a product URL", () => {
    expect(
      nameHintFromScan("https://verify.example.com/p/Paracetamol-500mg")
    ).toBe("Paracetamol 500mg");
  });

  it("uses a free-text QR payload", () => {
    expect(nameHintFromScan("Crocin Advance 500")).toBe("Crocin Advance 500");
  });

  it("returns null for an AI-only payload", () => {
    expect(nameHintFromScan("(01)08901234567890(17)271231")).toBeNull();
  });

  it("returns null for a plain retail barcode", () => {
    expect(nameHintFromScan("8901234567890")).toBeNull();
  });
});
