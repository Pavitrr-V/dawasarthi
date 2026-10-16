import { timingSafeEqual } from "node:crypto";

/**
 * Validates the `Authorization: Bearer <CRON_SECRET>` header on cron routes.
 * Uses a constant-time comparison. Returns false when CRON_SECRET is unset so
 * the routes are closed by default.
 */
export function isAuthorizedCron(request: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (secret.length === 0) return false;

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  const provided = Buffer.from(header);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;

  return timingSafeEqual(provided, wanted);
}
