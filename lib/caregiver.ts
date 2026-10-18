/**
 * Caregiver-linking helpers (pure, no I/O, no secrets).
 *
 * Shared by the patient and caregiver screens as well as the server
 * actions/routes, so it must stay importable from both the browser and
 * Node. Nothing here touches Supabase; the server-only data access lives
 * in lib/caregiver-server.ts.
 */

/**
 * Invite alphabet: A–Z without the ambiguous letters I and O, plus the
 * digits 2–9. 32 symbols, which divides 256 exactly, so mapping a random
 * byte with `% 32` introduces no modulo bias.
 */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Length of a caregiver invite code. */
export const INVITE_LENGTH = 8;

/** An unclaimed invite expires this many hours after it is created. */
export const INVITE_TTL_HOURS = 48;

/** Max *failed* join attempts allowed per user, per rolling window. */
export const JOIN_ATTEMPT_LIMIT = 10;

/** The rolling window for the join rate limit. */
export const JOIN_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Whole minutes until the oldest attempt in the window ages out and a
 * failed-attempt slot frees up. Returns at least 1 when time remains.
 */
export function rateLimitMinutesLeft(
  oldestAttemptAt: string | Date,
  now: number = Date.now()
): number {
  const oldest =
    oldestAttemptAt instanceof Date
      ? oldestAttemptAt.getTime()
      : Date.parse(oldestAttemptAt);
  if (Number.isNaN(oldest)) return 0;
  const remaining = oldest + JOIN_ATTEMPT_WINDOW_MS - now;
  return remaining <= 0 ? 0 : Math.ceil(remaining / (60 * 1000));
}

/** Generate a fresh invite code using the platform CSPRNG. */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  }
  return code;
}

/**
 * Normalise user-entered invite text: uppercase and keep only characters
 * that appear in the alphabet (drops spaces, dashes and look-alikes such
 * as "0" and "1"). Returns a possibly-short string; callers validate with
 * isValidInviteCode.
 */
export function normalizeInviteCode(raw: string | null | undefined): string {
  if (!raw) return "";
  const upper = raw.trim().toUpperCase();
  let out = "";
  for (const ch of upper) {
    if (INVITE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** True when `code` is exactly one valid invite code. */
export function isValidInviteCode(code: string): boolean {
  if (code.length !== INVITE_LENGTH) return false;
  for (const ch of code) {
    if (!INVITE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** True when an invite created at `createdAt` is older than the TTL. */
export function isInviteExpired(
  createdAt: string | Date,
  now: number = Date.now()
): boolean {
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (Number.isNaN(created)) return true;
  return now - created > INVITE_TTL_HOURS * 60 * 60 * 1000;
}

/** Whole hours remaining before an invite expires (never negative). */
export function inviteHoursLeft(
  createdAt: string | Date,
  now: number = Date.now()
): number {
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  const remaining = INVITE_TTL_HOURS * 60 * 60 * 1000 - (now - created);
  return remaining <= 0 ? 0 : Math.ceil(remaining / (60 * 60 * 1000));
}

/**
 * Best-effort E.164 conversion for an Indian mobile number.
 *
 * Accepts a bare 10-digit number (assumed +91), a 12-digit "91…" number,
 * or an already "+"-prefixed international number. Returns null for
 * anything else so the caller can reject it. A blank input is not an
 * error — the caller treats an empty string as "no phone".
 */
export function normalizeCaregiverPhone(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  if (digits.length === 10) {
    return /^[6-9]/.test(digits) ? `+91${digits}` : null;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    const local = digits.slice(2);
    return /^[6-9]/.test(local) ? `+91${local}` : null;
  }
  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

/** Hide all but the last two digits of a phone number, e.g. "+91••••••1234". */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 2) return phone;
  const tail = digits.slice(-2);
  return `${phone.startsWith("+") ? "+" : ""}••••${tail}`;
}

/** First name only — never expose a patient's full name before consent. */
export function firstName(fullName: string | null | undefined): string {
  if (!fullName) return "the patient";
  const trimmed = fullName.trim();
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/** Absolute URL a caregiver opens (or scans) to accept an invite. */
export function joinUrl(code: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/join?code=${encodeURIComponent(code)}`;
}

/** Relative path used for in-app links and the login "next" target. */
export function joinPath(code: string): string {
  return `/join?code=${encodeURIComponent(code)}`;
}

/**
 * Only allow same-origin, relative redirect targets. Blocks open-redirects
 * such as "//evil.com", "https://evil.com" and "/\evil.com".
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  if (next.startsWith("/\\")) return null;
  return next;
}

/** The statuses a caregiver_links.status row can hold (matches the DB check). */
export type CaregiverLinkStatus = "pending" | "active" | "revoked";

/** A caregiver link as shown on the patient "Family" screen. */
export type CaregiverLinkView = {
  id: string;
  status: CaregiverLinkStatus;
  consent_given: boolean;
  created_at: string;
  invite_code: string;
  /** Set once the caregiver has claimed the invite. */
  caregiver_user_id: string | null;
  /** Caregiver display name, resolved server-side (patient cannot read users). */
  caregiver_name: string | null;
  /** Caregiver phone, masked for display. */
  caregiver_phone_masked: string | null;
  /** True when the invite code has passed its 48h TTL and is still unclaimed. */
  expired: boolean;
};

/** For the caregiver's "Patients" screen. */
export type CaregiverPatientView = {
  id: string;
  status: CaregiverLinkStatus;
  consent_given: boolean;
  /** First name only; available once the patient owns the link. */
  patient_name: string;
  patient_id: string;
};
