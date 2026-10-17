import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Web Push sender. Server-only: it holds the VAPID private key and the
 * service-role client, so never import it from a client component.
 *
 * `sendPushToUser` fans a payload out to every stored subscription and prunes
 * the subscriptions the push service reports as gone (404/410). A missing key
 * or an empty subscription list is reported (never thrown) so callers such as
 * the reminder loop keep running.
 */

export type PushNotificationPayload = {
  title: string;
  body: string;
  /** Where a notification tap should land. Defaults to /home in the SW. */
  url?: string;
  /** Collapses re-notifications for the same dose. */
  tag?: string;
  /** Present only when the notification should show action buttons. */
  doseId?: string;
  /** Signed, short-lived URL the service worker POSTs the action to. */
  actionUrl?: string;
  actions?: boolean;
  icon?: string;
  badge?: string;
};

export type PushSendResult = {
  subscriptions: number;
  sent: number;
  failed: number;
  /** Subscriptions deleted because the push service said they were gone. */
  removed: number;
  skipped?: "disabled" | "no-subscriptions";
};

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

let configured = false;

/** True when both VAPID keys are present. */
export function pushConfigured(): boolean {
  return Boolean(
    (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "").trim() &&
      (process.env.VAPID_PRIVATE_KEY ?? "").trim()
  );
}

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!pushConfigured()) return false;

  const publicKey = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject =
    (process.env.VAPID_SUBJECT ?? "").trim() || "mailto:care@medscan.app";

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

/** Extracts the push service status code from a web-push error, if any. */
function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

/**
 * Sends one payload to every device the user has subscribed. Subscriptions
 * that return 404/410 are deleted.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushNotificationPayload,
  admin: SupabaseClient = createAdminClient()
): Promise<PushSendResult> {
  if (!ensureConfigured()) {
    return {
      subscriptions: 0,
      sent: 0,
      failed: 0,
      removed: 0,
      skipped: "disabled",
    };
  }

  const { data } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);

  const subscriptions = (data ?? []) as StoredSubscription[];
  if (subscriptions.length === 0) {
    return {
      subscriptions: 0,
      sent: 0,
      failed: 0,
      removed: 0,
      skipped: "no-subscriptions",
    };
  }

  const message = JSON.stringify(payload);
  const staleIds: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          message,
          { TTL: 60 * 60 }
        );
        sent += 1;
      } catch (error) {
        const statusCode = statusCodeOf(error);
        if (statusCode === 404 || statusCode === 410) {
          // The subscription is dead (uninstalled, permission revoked, ...).
          staleIds.push(subscription.id);
        } else {
          failed += 1;
        }
      }
    })
  );

  let removed = 0;
  for (const id of new Set(staleIds)) {
    const { error } = await admin
      .from("push_subscriptions")
      .delete()
      .eq("id", id);
    if (!error) removed += 1;
  }

  return { subscriptions: subscriptions.length, sent, failed, removed };
}
