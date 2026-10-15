import { describe, expect, it } from "vitest";
import {
  daysToExpiry,
  evaluateRisk,
  expiryStatus,
  type RiskInput,
  type RiskReason,
} from "./risk";

/** Fixed reference day so every assertions is deterministic. */
const TODAY = new Date("2026-10-15T00:00:00.000Z");

/** A completely valid medicine that must come out GREEN. */
function baseInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    name: "Paracetamol 500mg",
    composition: ["paracetamol"],
    batch_no: "ABC123",
    mfg_date: "2025-01-01",
    expiry_date: "2028-01-01",
    mrp: 50,
    license_no: "MH-ABC-1234",
    manufacturer: "Cipla Ltd",
    secondSide: null,
    datasetMatch: true,
    communityReportCount: 0,
    today: TODAY,
    alertMatches: [],
    onlineCheck: null,
    ...overrides,
  };
}

function codes(reasons: RiskReason[]): string[] {
  return reasons.map((reason) => reason.code);
}

function find(reasons: RiskReason[], code: string): RiskReason | undefined {
  return reasons.find((reason) => reason.code === code);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe("evaluateRisk baseline", () => {
  it("returns green with no reasons for a clean medicine", () => {
    const result = evaluateRisk(baseInput());
    expect(result.level).toBe("green");
    expect(result.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe("expiry", () => {
  it("marks an already-expired medicine RED", () => {
    const result = evaluateRisk(baseInput({ expiry_date: "2026-10-01" }));
    expect(result.level).toBe("red");
    expect(find(result.reasons, "EXPIRED")?.severity).toBe("red");
  });

  it("marks a medicine expiring today (0 days) AMBER", () => {
    const result = evaluateRisk(baseInput({ expiry_date: "2026-10-15" }));
    expect(result.level).toBe("amber");
    expect(find(result.reasons, "EXPIRED")).toBeUndefined();
    expect(find(result.reasons, "EXPIRING_SOON")).toBeDefined();
  });

  it("marks expiry exactly 30 days away AMBER (boundary)", () => {
    const result = evaluateRisk(baseInput({ expiry_date: "2026-11-14" }));
    expect(result.level).toBe("amber");
    expect(find(result.reasons, "EXPIRING_SOON")).toBeDefined();
  });

  it("does not warn at 31 days (boundary)", () => {
    const result = evaluateRisk(baseInput({ expiry_date: "2026-11-15" }));
    expect(result.level).toBe("green");
    expect(find(result.reasons, "EXPIRING_SOON")).toBeUndefined();
  });
});

describe("manufacturing date", () => {
  it("flags mfg after expiry as RED", () => {
    const result = evaluateRisk(
      baseInput({ mfg_date: "2025-06-01", expiry_date: "2025-01-01" })
    );
    expect(result.level).toBe("red");
    expect(find(result.reasons, "MFG_AFTER_EXPIRY")?.severity).toBe("red");
  });

  it("flags a future mfg date as RED", () => {
    const result = evaluateRisk(
      baseInput({ mfg_date: "2027-01-01", expiry_date: "2028-01-01" })
    );
    expect(result.level).toBe("red");
    expect(find(result.reasons, "MFG_IN_FUTURE")?.severity).toBe("red");
  });

  it("does not flag mfg equal to today", () => {
    const result = evaluateRisk(
      baseInput({ mfg_date: "2026-10-15", expiry_date: "2028-01-01" })
    );
    expect(find(result.reasons, "MFG_IN_FUTURE")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Missing mandatory fields
// ---------------------------------------------------------------------------

describe("missing mandatory fields", () => {
  it("reports one AMBER reason per missing field", () => {
    const result = evaluateRisk(
      baseInput({
        batch_no: null,
        mfg_date: null,
        license_no: null,
        mrp: null,
      })
    );
    expect(result.level).toBe("amber");
    expect(codes(result.reasons)).toEqual(
      expect.arrayContaining([
        "MISSING_BATCH",
        "MISSING_MFG_DATE",
        "MISSING_LICENSE",
        "MISSING_MRP",
      ])
    );
    for (const code of [
      "MISSING_BATCH",
      "MISSING_MFG_DATE",
      "MISSING_LICENSE",
      "MISSING_MRP",
    ]) {
      expect(find(result.reasons, code)?.severity).toBe("amber");
    }
  });

  it("treats empty/whitespace strings as missing", () => {
    const result = evaluateRisk(
      baseInput({ batch_no: "   ", license_no: "" })
    );
    expect(find(result.reasons, "MISSING_BATCH")).toBeDefined();
    expect(find(result.reasons, "MISSING_LICENSE")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Batch sanity
// ---------------------------------------------------------------------------

describe("batch number sanity", () => {
  it("warns on a too-short batch", () => {
    const result = evaluateRisk(baseInput({ batch_no: "AB" }));
    expect(find(result.reasons, "BATCH_FORMAT")?.severity).toBe("amber");
    expect(result.level).toBe("amber");
  });

  it("warns on a too-long batch", () => {
    const result = evaluateRisk(baseInput({ batch_no: "ABCDEFGHIJKLMNOP" }));
    expect(find(result.reasons, "BATCH_FORMAT")).toBeDefined();
  });

  it("warns when every character is the same", () => {
    const result = evaluateRisk(baseInput({ batch_no: "AAAAAA" }));
    expect(find(result.reasons, "BATCH_FORMAT")).toBeDefined();
  });

  it("warns on invalid characters", () => {
    const result = evaluateRisk(baseInput({ batch_no: "AB#12" }));
    expect(find(result.reasons, "BATCH_FORMAT")).toBeDefined();
  });

  it("accepts a normal alphanumeric batch with a dash or slash", () => {
    expect(
      find(evaluateRisk(baseInput({ batch_no: "AB-12/99" })).reasons, "BATCH_FORMAT")
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Strip vs box
// ---------------------------------------------------------------------------

describe("strip vs box cross-check", () => {
  it("flags a differing name as RED", () => {
    const result = evaluateRisk(
      baseInput({ secondSide: { name: "Something Else 250mg" } })
    );
    expect(result.level).toBe("red");
    expect(find(result.reasons, "PACK_NAME_MISMATCH")?.severity).toBe("red");
  });

  it("flags a differing batch as RED", () => {
    const result = evaluateRisk(
      baseInput({ secondSide: { batch_no: "ZZZ999" } })
    );
    expect(find(result.reasons, "PACK_BATCH_MISMATCH")?.severity).toBe("red");
  });

  it("flags a differing expiry as RED", () => {
    const result = evaluateRisk(
      baseInput({ secondSide: { expiry_date: "2029-01-01" } })
    );
    expect(find(result.reasons, "PACK_EXPIRY_MISMATCH")?.severity).toBe("red");
  });

  it("ignores formatting-only differences (normalized comparison)", () => {
    const result = evaluateRisk(
      baseInput({
        secondSide: {
          name: "paracetamol-500mg",
          batch_no: "abc/123",
          expiry_date: "2028-01-01",
        },
      })
    );
    expect(result.level).toBe("green");
    expect(codes(result.reasons)).not.toContain("PACK_NAME_MISMATCH");
    expect(codes(result.reasons)).not.toContain("PACK_BATCH_MISMATCH");
    expect(codes(result.reasons)).not.toContain("PACK_EXPIRY_MISMATCH");
  });

  it("does not flag when the second side is absent", () => {
    const result = evaluateRisk(baseInput({ secondSide: null }));
    expect(result.level).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Catalog membership
// ---------------------------------------------------------------------------

describe("dataset match", () => {
  it("flags datasetMatch === false as AMBER", () => {
    const result = evaluateRisk(baseInput({ datasetMatch: false }));
    expect(result.level).toBe("amber");
    expect(find(result.reasons, "NOT_IN_DATASET")?.severity).toBe("amber");
  });

  it("does not flag datasetMatch === true", () => {
    expect(find(evaluateRisk(baseInput({ datasetMatch: true })).reasons, "NOT_IN_DATASET")).toBeUndefined();
  });

  it("does not flag datasetMatch === null", () => {
    const result = evaluateRisk(baseInput({ datasetMatch: null }));
    expect(result.level).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Community reports
// ---------------------------------------------------------------------------

describe("community reports", () => {
  it("is AMBER for one report", () => {
    const result = evaluateRisk(baseInput({ communityReportCount: 1 }));
    expect(result.level).toBe("amber");
    expect(find(result.reasons, "COMMUNITY_REPORTS")?.severity).toBe("amber");
    expect(find(result.reasons, "COMMUNITY_REPORTS_HIGH")).toBeUndefined();
  });

  it("is AMBER for two reports", () => {
    const result = evaluateRisk(baseInput({ communityReportCount: 2 }));
    expect(result.level).toBe("amber");
  });

  it("is RED for three reports", () => {
    const result = evaluateRisk(baseInput({ communityReportCount: 3 }));
    expect(result.level).toBe("red");
    expect(find(result.reasons, "COMMUNITY_REPORTS_HIGH")?.severity).toBe("red");
    expect(find(result.reasons, "COMMUNITY_REPORTS")).toBeUndefined();
  });

  it("is green with zero reports", () => {
    expect(evaluateRisk(baseInput({ communityReportCount: 0 })).level).toBe(
      "green"
    );
  });
});

// ---------------------------------------------------------------------------
// Official alerts
// ---------------------------------------------------------------------------

describe("alert matches", () => {
  it("marks a name_and_batch alert RED and carries the source URL", () => {
    const result = evaluateRisk(
      baseInput({
        alertMatches: [
          {
            alert_type: "nsq",
            product_name: "Paracetamol 500mg",
            batch_no: "ABC123",
            alert_date: "2026-03-01",
            source_url: "https://cdsco.gov.in/alert/123",
            matchType: "name_and_batch",
          },
        ],
      })
    );
    expect(result.level).toBe("red");
    const reason = find(result.reasons, "ALERT_BATCH_MATCH");
    expect(reason?.severity).toBe("red");
    expect(reason?.source_url).toBe("https://cdsco.gov.in/alert/123");
  });

  it("keeps a name_only alert at INFO and does not change the level", () => {
    const result = evaluateRisk(
      baseInput({
        alertMatches: [
          {
            alert_type: "spurious",
            product_name: "Paracetamol 500mg",
            batch_no: "OTHER1",
            alert_date: "2026-02-01",
            source_url: "https://cdsco.gov.in/alert/999",
            matchType: "name_only",
          },
        ],
      })
    );
    expect(result.level).toBe("green");
    expect(find(result.reasons, "ALERT_OTHER_BATCH")?.severity).toBe("info");
  });

  it("collapses many name_only alerts into a single INFO reason", () => {
    const result = evaluateRisk(
      baseInput({
        alertMatches: [
          {
            alert_type: "nsq",
            product_name: "Paracetamol 500mg",
            batch_no: "B1",
            alert_date: "2026-01-01",
            source_url: "https://x/1",
            matchType: "name_only",
          },
          {
            alert_type: "nsq",
            product_name: "Paracetamol 500mg",
            batch_no: "B2",
            alert_date: "2026-01-02",
            source_url: "https://x/2",
            matchType: "name_only",
          },
        ],
      })
    );
    expect(
      result.reasons.filter((r) => r.code === "ALERT_OTHER_BATCH")
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Online (TinyFish) verification
// ---------------------------------------------------------------------------

describe("online check", () => {
  it("is ignored when null", () => {
    const result = evaluateRisk(baseInput({ onlineCheck: null }));
    expect(result.level).toBe("green");
    expect(result.reasons).toEqual([]);
  });

  it("flags a listed MRP that differs by more than 15% as AMBER", () => {
    const result = evaluateRisk(
      baseInput({
        onlineCheck: {
          status: "found",
          listed_mrp: 100,
          confidence: 0.9,
          source_url: "https://pharmacy.example/p/1",
        },
      })
    );
    expect(result.level).toBe("amber");
    const reason = find(result.reasons, "MRP_MISMATCH");
    expect(reason?.severity).toBe("amber");
    expect(reason?.source_url).toBe("https://pharmacy.example/p/1");
  });

  it("ignores an MRP difference of exactly 15% (boundary)", () => {
    const result = evaluateRisk(
      baseInput({ onlineCheck: { status: "found", listed_mrp: 57.5, confidence: 0.9 } })
    );
    expect(find(result.reasons, "MRP_MISMATCH")).toBeUndefined();
  });

  it("flags a manufacturer mismatch (normalized) as AMBER", () => {
    const result = evaluateRisk(
      baseInput({
        onlineCheck: {
          status: "found",
          listed_manufacturer: "Sun Pharma",
          confidence: 0.8,
        },
      })
    );
    expect(find(result.reasons, "MANUFACTURER_MISMATCH")?.severity).toBe("amber");
  });

  it("ignores formatting-only manufacturer differences", () => {
    const result = evaluateRisk(
      baseInput({
        onlineCheck: {
          status: "found",
          listed_manufacturer: "cipla ltd.",
          confidence: 0.8,
        },
      })
    );
    expect(find(result.reasons, "MANUFACTURER_MISMATCH")).toBeUndefined();
  });

  it("applies checks at exactly the confidence threshold", () => {
    const result = evaluateRisk(
      baseInput({ onlineCheck: { status: "found", listed_mrp: 60, confidence: 0.7 } })
    );
    expect(find(result.reasons, "MRP_MISMATCH")).toBeDefined();
  });

  it("ignores low-confidence online facts completely", () => {
    const result = evaluateRisk(
      baseInput({
        onlineCheck: {
          status: "found",
          listed_mrp: 100,
          listed_manufacturer: "Sun Pharma",
          confidence: 0.5,
        },
      })
    );
    expect(result.level).toBe("green");
    expect(result.reasons).toEqual([]);
  });

  it("ignores online facts when confidence is missing", () => {
    const result = evaluateRisk(
      baseInput({ onlineCheck: { status: "found", listed_mrp: 100 } })
    );
    expect(result.level).toBe("green");
  });

  it("flags not_found as an AMBER soft warning", () => {
    const result = evaluateRisk(
      baseInput({ onlineCheck: { status: "not_found" } })
    );
    expect(result.level).toBe("amber");
    expect(find(result.reasons, "ONLINE_NOT_FOUND")?.severity).toBe("amber");
  });

  it("treats pending as INFO with no effect on the level", () => {
    const result = evaluateRisk(baseInput({ onlineCheck: { status: "pending" } }));
    expect(result.level).toBe("green");
    expect(find(result.reasons, "ONLINE_PENDING")?.severity).toBe("info");
  });

  it("treats error as INFO with no effect on the level", () => {
    const result = evaluateRisk(baseInput({ onlineCheck: { status: "error" } }));
    expect(result.level).toBe("green");
    expect(find(result.reasons, "ONLINE_ERROR")?.severity).toBe("info");
  });

  it("never returns RED from an online check alone", () => {
    for (const status of ["not_found", "pending", "error"] as const) {
      expect(evaluateRisk(baseInput({ onlineCheck: { status } })).level).not.toBe(
        "red"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

describe("level aggregation", () => {
  it("INFO alone still yields green", () => {
    const result = evaluateRisk(
      baseInput({
        onlineCheck: { status: "pending" },
        alertMatches: [
          {
            alert_type: "nsq",
            product_name: "Paracetamol 500mg",
            batch_no: "B9",
            alert_date: "2026-01-01",
            source_url: "https://x/9",
            matchType: "name_only",
          },
        ],
      })
    );
    expect(result.level).toBe("green");
    expect(result.reasons.every((r) => r.severity === "info")).toBe(true);
  });

  it("AMBER + INFO yields amber", () => {
    const result = evaluateRisk(
      baseInput({
        datasetMatch: false,
        onlineCheck: { status: "pending" },
      })
    );
    expect(result.level).toBe("amber");
  });

  it("AMBER + RED yields red", () => {
    const result = evaluateRisk(
      baseInput({ datasetMatch: false, expiry_date: "2020-01-01" })
    );
    expect(result.level).toBe("red");
  });

  it("sorts reasons RED -> AMBER -> INFO", () => {
    const result = evaluateRisk(
      baseInput({
        datasetMatch: false, // amber
        onlineCheck: { status: "pending" }, // info
        expiry_date: "2020-01-01", // red
      })
    );
    const rank = { red: 0, amber: 1, info: 2 } as const;
    const ranks = result.reasons.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(result.level).toBe("red");
  });

  it("every reason ships both English and Hindi text", () => {
    const result = evaluateRisk(
      baseInput({
        batch_no: "AB",
        datasetMatch: false,
        expiry_date: "2020-01-01",
        onlineCheck: { status: "not_found" },
      })
    );
    for (const reason of result.reasons) {
      expect(reason.message_en.length).toBeGreaterThan(0);
      expect(reason.message_hi.length).toBeGreaterThan(0);
      expect(reason.message_en).not.toBe(reason.message_hi);
    }
  });
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

describe("daysToExpiry", () => {
  it("counts whole days from today", () => {
    expect(daysToExpiry("2026-11-14", TODAY)).toBe(30);
    expect(daysToExpiry("2026-10-15", TODAY)).toBe(0);
  });

  it("returns a negative number for a past date", () => {
    expect(daysToExpiry("2026-10-14", TODAY)).toBe(-1);
  });

  it("returns null for missing or malformed dates", () => {
    expect(daysToExpiry(null, TODAY)).toBeNull();
    expect(daysToExpiry(undefined, TODAY)).toBeNull();
    expect(daysToExpiry("not-a-date", TODAY)).toBeNull();
    expect(daysToExpiry("2026-02-31", TODAY)).toBeNull();
  });
});

describe("expiryStatus", () => {
  it("buckets expired / expiring soon / valid / unknown", () => {
    expect(expiryStatus("2026-10-14", TODAY)).toBe("expired");
    expect(expiryStatus("2026-11-14", TODAY)).toBe("expiring_soon");
    expect(expiryStatus("2028-01-01", TODAY)).toBe("valid");
    expect(expiryStatus(null, TODAY)).toBe("unknown");
  });
});
