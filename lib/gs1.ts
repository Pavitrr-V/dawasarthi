/**
 * GS1 / barcode payload parsing.
 *
 * A scanned code is one of three shapes:
 *   1. A GS1 element string with application identifiers, with or without
 *      parentheses: "(01)0890...(17)271231" or "010890...17271231".
 *   2. A plain retail barcode (EAN-8 / UPC-A / EAN-13 / GTIN-14): just digits.
 *   3. Free text or a URL, e.g. a QR code printed on the pack.
 *
 * This module is pure (no DOM, no network) so it can be unit-tested directly.
 * A scanned payload is untrusted input: we only ever read fields we recognise.
 */

/** Application identifiers with a known fixed value length. */
const FIXED_LENGTH_AIS: Record<string, number> = {
  "01": 14, // GTIN
  "17": 6, // Expiry date, YYMMDD
};

/** Application identifiers whose value runs until a separator or end of input. */
const VARIABLE_LENGTH_AIS = new Set([
  "10", // Batch / lot number
  "21", // Serial number
]);

/** ASCII 29 (GS). Encoders use it (FNC1) to end a variable-length field. */
const GROUP_SEPARATOR = "\u001D";

export type Gs1DatePrecision = "day" | "month";

export type Gs1Result = {
  /** Scanned text, trimmed, with the AIM prefix and separators removed. */
  raw: string;
  /** True when at least one GS1 application identifier was decoded. */
  isGs1: boolean;
  /** AI 01, or the bare digits of a plain retail barcode. */
  gtin: string | null;
  /** AI 10 batch / lot number. */
  batch: string | null;
  /** AI 17 expiry as YYYY-MM-DD. A "00" day is normalised to the 1st. */
  expiry: string | null;
  /** "month" when the GS1 expiry day was "00", otherwise "day". */
  expiryPrecision: Gs1DatePrecision | null;
  /** AI 21 serial number. */
  serial: string | null;
  /** Every decoded application identifier in order, e.g. { "01": ["0890..."] }. */
  fields: Record<string, string[]>;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function first(values: string[] | undefined): string | null {
  return values && values.length > 0 ? values[0] : null;
}

function pushField(
  fields: Record<string, string[]>,
  ai: string,
  value: string
): void {
  if (!value) return;
  (fields[ai] ??= []).push(value);
}

/** Strip the AIM symbology identifier (e.g. "]C1") and stray separators. */
function normalize(input: string): string {
  return (input ?? "")
    .trim()
    .replace(/^\][A-Za-z]\d/, "")
    .replace(/^\u001D+/, "")
    .replace(/\u001D+$/, "");
}

/**
 * Parse the "(01)...(17)..." form. Application identifiers delimit the values,
 * so no length table is needed and non-numeric values are tolerated.
 */
function parseParenthesised(input: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  const pattern = /\((\d{2,4})\)/g;
  const markers: { ai: string; markerStart: number; valueStart: number }[] = [];

  let match = pattern.exec(input);
  while (match !== null) {
    markers.push({
      ai: match[1],
      markerStart: match.index,
      valueStart: pattern.lastIndex,
    });
    match = pattern.exec(input);
  }

  for (let index = 0; index < markers.length; index++) {
    const { ai, valueStart } = markers[index];
    const valueEnd =
      index + 1 < markers.length ? markers[index + 1].markerStart : input.length;
    const value = input
      .slice(valueStart, valueEnd)
      .replace(/\u001D/g, "")
      .trim();
    pushField(fields, ai, value);
  }

  return fields;
}

/**
 * Parse the unparenthesised form by walking known identifiers left to right.
 * Stops at the first unknown identifier so a plain EAN is not misread.
 */
function parseSequential(input: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  let index = 0;

  while (index < input.length) {
    if (input[index] === GROUP_SEPARATOR) {
      index++;
      continue;
    }

    const ai = input.slice(index, index + 2);
    if (!/^\d{2}$/.test(ai)) break;
    index += 2;

    const fixedLength = FIXED_LENGTH_AIS[ai];
    if (fixedLength !== undefined) {
      const value = input.slice(index, index + fixedLength);
      if (value.length < fixedLength || !/^\d+$/.test(value)) break;
      pushField(fields, ai, value);
      index += fixedLength;
      continue;
    }

    if (VARIABLE_LENGTH_AIS.has(ai)) {
      let end = index;
      while (end < input.length && input[end] !== GROUP_SEPARATOR) end++;
      const value = input.slice(index, end).trim();
      if (!value) break;
      pushField(fields, ai, value);
      index = end;
      continue;
    }

    // Unknown identifier: the remaining text is not a GS1 element string.
    break;
  }

  return fields;
}

/**
 * Convert an AI 17 "YYMMDD" expiry to YYYY-MM-DD.
 * GS1 carries no century: 00-49 -> 2000-2049, 50-99 -> 1950-1999.
 * Day "00" means "the whole month", normalised to the 1st.
 */
function parseExpiry(value: string | null): {
  expiry: string | null;
  expiryPrecision: Gs1DatePrecision | null;
} {
  if (!value || !/^\d{6}$/.test(value)) {
    return { expiry: null, expiryPrecision: null };
  }

  const yy = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12 || day > 31) {
    return { expiry: null, expiryPrecision: null };
  }

  const year = yy <= 49 ? 2000 + yy : 1900 + yy;
  const iso = `${year}-${pad2(month)}-${pad2(day === 0 ? 1 : day)}`;
  return { expiry: iso, expiryPrecision: day === 0 ? "month" : "day" };
}

/** Parse a scanned barcode / QR payload into the fields MedScan understands. */
export function parseGs1(rawInput: string): Gs1Result {
  const raw = normalize(rawInput);
  const empty: Gs1Result = {
    raw,
    isGs1: false,
    gtin: null,
    batch: null,
    expiry: null,
    expiryPrecision: null,
    serial: null,
    fields: {},
  };

  if (!raw) return empty;

  const fields = raw.includes("(")
    ? parseParenthesised(raw)
    : parseSequential(raw);

  if (Object.keys(fields).length === 0) {
    // Plain retail barcode: EAN-8, UPC-A, EAN-13 or GTIN-14.
    const digits = raw.replace(/[\s\u001D]/g, "");
    if (/^\d{8}$|^\d{12,14}$/.test(digits)) {
      return { ...empty, gtin: digits };
    }
    return empty;
  }

  const { expiry, expiryPrecision } = parseExpiry(first(fields["17"]));

  return {
    raw,
    isGs1: true,
    gtin: first(fields["01"]),
    batch: first(fields["10"]),
    expiry,
    expiryPrecision,
    serial: first(fields["21"]),
    fields,
  };
}

const URL_PATTERN = /https?:\/\/[^\s]+/i;
const FILE_EXTENSION = /\.(?:html?|php|aspx?|jsp|json)$/i;

function looksLikeName(value: string): boolean {
  return value.length >= 3 && /[a-z]/i.test(value);
}

/**
 * Best-effort product-name hint used to fuzzy-match medicine_catalog.
 *
 * medicine_catalog has no barcode column, so a match is only possible when the
 * payload carries a name. GS1 element strings carry identifiers, not names, and
 * plain retail barcodes are digits only, so both return null (the caller then
 * falls back to photo OCR).
 */
export function nameHintFromScan(rawInput: string): string | null {
  const parsed = parseGs1(rawInput);
  const text = parsed.raw;
  if (!text) return null;

  const url = text.match(URL_PATTERN)?.[0];
  if (url) {
    const segment = url.split(/[?#]/)[0].split("/").filter(Boolean).pop();
    if (!segment) return null;

    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Keep the raw segment when it is not valid percent-encoding.
    }

    const cleaned = decoded
      .replace(FILE_EXTENSION, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\b\d{3,}\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return looksLikeName(cleaned) ? cleaned : null;
  }

  // "(01)...(17)..." style payloads carry no product name.
  if (parsed.isGs1) return null;
  // A plain retail barcode is digits only.
  if (/^\d+$/.test(text)) return null;

  const cleaned = text.replace(/\u001D+/g, " ").replace(/\s+/g, " ").trim();
  return looksLikeName(cleaned) ? cleaned : null;
}
