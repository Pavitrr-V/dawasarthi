import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Short-lived, signed tokens for dose actions taken from a push notification.
 *
 * A service worker cannot rely on the Supabase session cookie (iOS in
 * particular, and the app is often closed), so the push payload carries a URL
 * like `/api/dose/<id>/action?token=<token>`. The token proves *which user*
 * the notification belonged to and *which dose* it was for, and it expires.
 *
 * Server-only: imports node:crypto, so never import this from a client
 * component.
 */

/** How long an action button stays valid after the notification is sent. */
export const DOSE_ACTION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const tokenSchema = z.object({
  dose_id: z.string().uuid(),
  user_id: z.string().uuid(),
  /** Unix seconds. */
  exp: z.number().int().positive(),
});

export type DoseActionTokenPayload = z.infer<typeof tokenSchema>;

/**
 * The HMAC secret. A dedicated secret is preferred; falling back to the VAPID
 * private key keeps local/dev setups working with only the push keys set.
 * Throws (rather than returning an insecure default) when neither is present.
 */
function signingSecret(): string {
  const value = (
    process.env.PUSH_ACTION_SECRET ??
    process.env.VAPID_PRIVATE_KEY ??
    ""
  ).trim();

  if (value.length === 0) {
    throw new Error(
      "Missing PUSH_ACTION_SECRET (or VAPID_PRIVATE_KEY) for signing dose action tokens."
    );
  }
  return value;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", signingSecret())
    .update(encodedPayload)
    .digest("base64url");
}

export type CreateDoseActionTokenInput = {
  doseId: string;
  userId: string;
  now?: number;
};

/** Mints `<base64url(payload)>.<hmac>` valid for DOSE_ACTION_TOKEN_TTL_MS. */
export function createDoseActionToken({
  doseId,
  userId,
  now = Date.now(),
}: CreateDoseActionTokenInput): string {
  const payload: DoseActionTokenPayload = {
    dose_id: doseId,
    user_id: userId,
    exp: Math.floor((now + DOSE_ACTION_TOKEN_TTL_MS) / 1000),
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Verifies the signature and expiry. Returns the payload, or null for any
 * malformed, tampered, or expired token. Never throws on bad input.
 */
export function verifyDoseActionToken(
  token: string | null | undefined,
  now: number = Date.now()
): DoseActionTokenPayload | null {
  if (typeof token !== "string" || token.length === 0) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const encoded = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);

  let expectedSignature: string;
  try {
    expectedSignature = sign(encoded);
  } catch {
    // No signing secret configured; treat every token as invalid.
    return null;
  }

  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const parsed = tokenSchema.safeParse(decoded);
  if (!parsed.success) return null;

  if (parsed.data.exp * 1000 <= now) return null;

  return parsed.data;
}

/** Builds the signed, absolute-or-relative action URL for a notification. */
export function doseActionUrl(
  doseId: string,
  userId: string,
  now: number = Date.now()
): string {
  const token = createDoseActionToken({ doseId, userId, now });
  return `/api/dose/${doseId}/action?token=${encodeURIComponent(token)}`;
}
