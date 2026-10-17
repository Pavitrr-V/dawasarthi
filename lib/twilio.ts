/**
 * Twilio REST wrapper for SMS + WhatsApp. Server-only.
 *
 * Used by the reminder worker to escalate a missed dose to a caregiver when a
 * push cannot reach them. Deliberately dependency-free: it talks to the Twilio
 * Messages API with `fetch`, so no SDK is bundled and the auth token never
 * leaves the server.
 *
 * Env (never exposed to the client):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_SMS_FROM        e.g. +14155550123
 *   TWILIO_WHATSAPP_FROM   e.g. whatsapp:+14155238886
 *
 * Nothing here logs the body or the token.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const TWILIO_TIMEOUT_MS = 8_000;
/** Twilio rejects an SMS body over 1600 chars. */
const MAX_BODY_LEN = 1600;

export type TwilioChannel = "sms" | "whatsapp";

export type TwilioResult = {
  channel: TwilioChannel;
  /** The normalised E.164 number the message was addressed to. */
  to: string;
  /** Twilio's message SID (empty string when the API omitted it). */
  sid: string;
};

/** Raised for a missing key / malformed input before any network call. */
export class TwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioConfigError";
  }
}

/** Raised when Twilio returns a non-2xx response. */
export class TwilioError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TwilioError";
    this.status = status;
  }
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** True when the account sid + auth token are present. */
export function twilioConfigured(): boolean {
  return env("TWILIO_ACCOUNT_SID").length > 0 && env("TWILIO_AUTH_TOKEN").length > 0;
}

/**
 * Best-effort conversion to E.164. Formats are unpredictable, so this keeps a
 * leading "+", strips separators, and assumes India (+91) for a bare 10-digit
 * number. Returns null when there is nothing usable.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return `+${digits}`;
}

function truncateBody(body: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > MAX_BODY_LEN ? clean.slice(0, MAX_BODY_LEN - 1) + "…" : clean;
}

async function postMessage(input: {
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string }> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  if (!sid || !token) {
    throw new TwilioConfigError("Twilio is not configured (missing sid or auth token).");
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({
    From: input.from,
    To: input.to,
    Body: truncateBody(input.body),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);
  try {
    const response = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | { sid?: unknown; message?: unknown }
      | null;

    if (!response.ok) {
      const detail =
        payload && typeof payload.message === "string"
          ? payload.message
          : `Twilio request failed with status ${response.status}.`;
      throw new TwilioError(detail, response.status);
    }

    return { sid: typeof payload?.sid === "string" ? payload.sid : "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one SMS. Throws TwilioError / TwilioConfigError on failure. */
export async function sendSms(to: string, body: string): Promise<TwilioResult> {
  const from = env("TWILIO_SMS_FROM");
  if (!from) throw new TwilioConfigError("Missing TWILIO_SMS_FROM.");
  const normalized = normalizePhone(to);
  if (!normalized) throw new TwilioConfigError("Invalid destination phone number.");

  const { sid } = await postMessage({ from, to: normalized, body });
  return { channel: "sms", to: normalized, sid };
}

/** Sends one WhatsApp message. Throws TwilioError / TwilioConfigError. */
export async function sendWhatsApp(to: string, body: string): Promise<TwilioResult> {
  const from = env("TWILIO_WHATSAPP_FROM");
  if (!from) throw new TwilioConfigError("Missing TWILIO_WHATSAPP_FROM.");
  const normalized = normalizePhone(to);
  if (!normalized) throw new TwilioConfigError("Invalid destination phone number.");

  const { sid } = await postMessage({ from, to: `whatsapp:${normalized}`, body });
  return { channel: "whatsapp", to: normalized, sid };
}
