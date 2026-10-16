import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_FIELD_LEN,
  matchAlerts,
  monthYearToDate,
  normalizeBatch,
  normalizeName,
  parseAgentAlerts,
  upsertNsqAlerts,
  type NsqAlertRow,
} from "@/lib/alerts";

// ---------------------------------------------------------------------------
// normalizeName / normalizeBatch
// ---------------------------------------------------------------------------

describe("normalizeName", () => {
  it("lowercases and collapses separators to single spaces", () => {
    expect(normalizeName("SHELCAL Neu!")).toBe("shelcal neu");
    expect(normalizeName("Calcium   Carbonate")).toBe("calcium carbonate");
    expect(normalizeName("Cefuroxime Axetil IP")).toBe("cefuroxime axetil ip");
  });

  it("returns an empty string for non-strings", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName("   ")).toBe("");
  });
});

describe("normalizeBatch", () => {
  it("ignores case and every separator", () => {
    expect(normalizeBatch("ct-503513c")).toBe("ct503513c");
    expect(normalizeBatch("CT503513C")).toBe("ct503513c");
    expect(normalizeBatch("SNT/250038")).toBe("snt250038");
  });

  it("returns an empty string for non-strings", () => {
    expect(normalizeBatch(null)).toBe("");
    expect(normalizeBatch(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// monthYearToDate
// ---------------------------------------------------------------------------

describe("monthYearToDate", () => {
  it("converts a reporting month to the first of the month", () => {
    expect(monthYearToDate("AUG-2026")).toBe("2026-08-01");
    expect(monthYearToDate("SEPT 2026")).toBe("2026-09-01");
    expect(monthYearToDate("aug/2026")).toBe("2026-08-01");
    expect(monthYearToDate("DEC.2026")).toBe("2026-12-01");
  });

  it("returns null for unparseable values", () => {
    expect(monthYearToDate("")).toBeNull();
    expect(monthYearToDate("2026")).toBeNull();
    expect(monthYearToDate("XYZ-2026")).toBeNull();
    expect(monthYearToDate(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseAgentAlerts (untrusted payload validation)
// ---------------------------------------------------------------------------

const SOURCE = "https://cdscoonline.gov.in/CDSCO/viewPublicNSQDrug";

describe("parseAgentAlerts", () => {
  it("validates and normalises a good payload", () => {
    const rows = parseAgentAlerts(
      {
        alerts: [
          {
            product_name: "SHELCAL Neu",
            batch_no: "2SG6N020",
            manufacturer: "Torrent Pharmaceuticals",
            alert_type: "nsq",
            reporting_month_year: "AUG-2026",
            source_link: "https://example.com/notice",
          },
        ],
      },
      SOURCE
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      product_name: "SHELCAL Neu",
      product_name_norm: "shelcal neu",
      batch_no: "2SG6N020",
      batch_no_norm: "2sg6n020",
      alert_type: "nsq",
      alert_date: "2026-08-01",
      source_url: SOURCE,
    });
  });

  it("drops rows with no product name or no parseable month", () => {
    const rows = parseAgentAlerts(
      {
        alerts: [
          { product_name: "", reporting_month_year: "AUG-2026" },
          { product_name: "Good One", reporting_month_year: "nonsense" },
          { product_name: "Good Two", reporting_month_year: "JUL-2026" },
        ],
      },
      SOURCE
    );

    expect(rows.map((row) => row.product_name)).toEqual(["Good Two"]);
  });

  it("returns [] for a payload that is not { alerts: [...] }", () => {
    expect(parseAgentAlerts(null, SOURCE)).toEqual([]);
    expect(parseAgentAlerts({ nope: true }, SOURCE)).toEqual([]);
  });

  it("trims long string fields to MAX_FIELD_LEN", () => {
    const long = "x".repeat(500);
    const rows = parseAgentAlerts(
      {
        alerts: [
          {
            product_name: long,
            manufacturer: long,
            reporting_month_year: "AUG-2026",
          },
        ],
      },
      SOURCE
    );

    expect(rows[0].product_name).toHaveLength(MAX_FIELD_LEN);
    expect(rows[0].manufacturer).toHaveLength(MAX_FIELD_LEN);
  });

  it("caps the number of rows processed at 100", () => {
    const alerts = Array.from({ length: 150 }, (_, index) => ({
      product_name: `Medicine ${index}`,
      reporting_month_year: "AUG-2026",
    }));
    const rows = parseAgentAlerts({ alerts }, SOURCE);
    expect(rows).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// matchAlerts (matchType logic)
// ---------------------------------------------------------------------------

function clientWithRpc(data: unknown[], error: unknown = null): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue({ data, error }),
  } as unknown as SupabaseClient;
}

const ALERT_ROW = {
  id: "a1",
  product_name: "Cefuroxime Axetil IP",
  product_name_norm: "cefuroxime axetil ip",
  batch_no: "CT503513C",
  batch_no_norm: "ct503513c",
  manufacturer: "Nikvin Healthcare",
  alert_type: "nsq",
  alert_date: "2026-08-01",
  source_url: SOURCE,
  fetched_at: "2026-08-02T00:00:00Z",
  raw: {},
  similarity: 0.9,
};

describe("matchAlerts", () => {
  it("classifies same name + same batch as name_and_batch", async () => {
    const client = clientWithRpc([ALERT_ROW]);
    const matches = await matchAlerts(client, {
      name: "Cefuroxime Axetil IP",
      batch_no: "ct-503513c",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe("name_and_batch");
  });

  it("classifies same name + different batch as name_only", async () => {
    const client = clientWithRpc([ALERT_ROW]);
    const matches = await matchAlerts(client, {
      name: "Cefuroxime Axetil IP",
      batch_no: "SOME-OTHER-BATCH",
    });
    expect(matches[0].matchType).toBe("name_only");
  });

  it("classifies a missing batch as name_only", async () => {
    const client = clientWithRpc([ALERT_ROW]);
    const matches = await matchAlerts(client, {
      name: "Cefuroxime Axetil IP",
      batch_no: null,
    });
    expect(matches[0].matchType).toBe("name_only");
  });

  it("propagates the demo flag from raw", async () => {
    const client = clientWithRpc([{ ...ALERT_ROW, raw: { demo: true } }]);
    const matches = await matchAlerts(client, { name: "Cefuroxime Axetil IP" });
    expect(matches[0].demo).toBe(true);
  });

  it("returns [] for a short name or an RPC error", async () => {
    expect(await matchAlerts(clientWithRpc([]), { name: "ab" })).toEqual([]);
    expect(
      await matchAlerts(clientWithRpc([], { message: "boom" }), {
        name: "Cefuroxime Axetil IP",
      })
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// upsertNsqAlerts (never downgrade an existing row)
// ---------------------------------------------------------------------------

describe("upsertNsqAlerts", () => {
  function adminWithExisting(existing: Record<string, unknown>[]) {
    const upserted: Record<string, unknown>[][] = [];
    const admin = {
      from: () => ({
        select: () => ({ limit: async () => ({ data: existing, error: null }) }),
        upsert: (rows: Record<string, unknown>[]) => {
          upserted.push(rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;
    return { admin, upserted };
  }

  const incoming: NsqAlertRow = {
    product_name: "Demo", // shorter than the existing longer name
    product_name_norm: "demo",
    batch_no: "X",
    batch_no_norm: "x",
    manufacturer: "",
    alert_type: "nsq",
    alert_date: "2026-08-01",
    source_url: SOURCE,
    raw: { source: "csv" },
  };

  it("keeps the longer existing value and preserves a demo flag", async () => {
    const { admin, upserted } = adminWithExisting([
      {
        product_name: "A Much Longer Product Name",
        product_name_norm: "demo",
        batch_no: "X",
        batch_no_norm: "x",
        manufacturer: "Real Manufacturer",
        alert_type: "nsq",
        alert_date: "2026-08-01",
        source_url: SOURCE,
        raw: { demo: true },
      },
    ]);

    await upsertNsqAlerts(admin, [incoming]);

    const row = upserted[0][0];
    expect(row.product_name).toBe("A Much Longer Product Name");
    expect(row.manufacturer).toBe("Real Manufacturer");
    expect(row.raw).toMatchObject({ demo: true, source: "csv" });
  });

  it("does nothing when there are no rows", async () => {
    const { admin, upserted } = adminWithExisting([]);
    const result = await upsertNsqAlerts(admin, []);
    expect(result).toEqual({ attempted: 0, written: 0 });
    expect(upserted).toHaveLength(0);
  });
});
