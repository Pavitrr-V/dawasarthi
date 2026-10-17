/**
 * Validation for the untrusted price-comparison payload returned by the
 * TinyFish agent. Pure (no server imports) so it stays unit-testable.
 *
 * The agent is asked for {"quotes": [...]}; everything is treated as
 * untrusted: strings are bounded, numbers must be finite and plausible, and
 * anything malformed is dropped rather than stored.
 */

const MAX_QUOTES = 25;
const MAX_FIELD_LEN = 200;
const MAX_URL_LEN = 1000;
const MAX_PRICE = 1_000_000;

export type PriceQuote = {
  source_site: string;
  source_url: string;
  price: number;
  pack_size: string | null;
  in_stock: boolean | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const cleaned = value.trim().replace(/[^\d.]/g, "");
    if (cleaned.length === 0) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "yes", "in stock", "instock", "available"].includes(lower)) return true;
    if (["false", "no", "out of stock", "outofstock", "unavailable"].includes(lower)) {
      return false;
    }
  }
  return null;
}

/** The agent sometimes returns the JSON as a string; accept both shapes. */
function coerceResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function siteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Validates the untrusted agent payload into storable price quotes. */
export function parsePriceResult(payload: unknown): PriceQuote[] {
  const root = asRecord(coerceResult(payload));
  if (!root) return [];

  const list = Array.isArray(root.quotes) ? root.quotes : [];
  const quotes: PriceQuote[] = [];

  for (const raw of list) {
    const record = asRecord(raw);
    if (!record) continue;

    const sourceUrl = text(record.source_url).slice(0, MAX_URL_LEN);
    const site = (text(record.source_site) || siteHost(sourceUrl)).slice(0, MAX_FIELD_LEN);
    const price = asNumber(record.price);

    if (!sourceUrl || !site) continue;
    if (price === null || price < 0 || price > MAX_PRICE) continue;

    const packSize = text(record.pack_size).slice(0, MAX_FIELD_LEN) || null;

    quotes.push({
      source_site: site,
      source_url: sourceUrl,
      price,
      pack_size: packSize,
      in_stock: asBoolean(record.in_stock),
    });

    if (quotes.length >= MAX_QUOTES) break;
  }

  return quotes;
}
