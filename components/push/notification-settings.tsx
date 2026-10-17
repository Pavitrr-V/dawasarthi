"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";

/**
 * "Enable notifications" + "Send me a test notification".
 *
 * Registers public/sw.js, asks for permission, subscribes with the VAPID
 * public key and saves the subscription to /api/push/subscribe. On iPhone the
 * banner explains that the app must be added to the Home Screen first: Safari
 * only allows web push for installed (standalone) web apps.
 */

const VAPID_PUBLIC_KEY = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "").trim();

type Phase = "loading" | "unsupported" | "off" | "on" | "denied";

type Feedback = { tone: "ok" | "error" | "info"; text: string } | null;

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function NotificationSettings() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [showIosHint, setShowIosHint] = useState(false);
  const [working, setWorking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;

    // All state updates happen inside this async task (not synchronously in
    // the effect body), which keeps the browser APIs out of render.
    const init = async () => {
      const supported =
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window;

      const standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone ===
          true;
      const ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent);

      if (cancelled) return;
      setShowIosHint(ios && !standalone);

      if (!supported) {
        setPhase("unsupported");
        return;
      }

      if (Notification.permission === "denied") {
        setPhase("denied");
        return;
      }

      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const existing = registration
          ? await registration.pushManager.getSubscription()
          : null;
        if (!cancelled) setPhase(existing ? "on" : "off");
      } catch {
        if (!cancelled) setPhase("off");
      }
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setFeedback(null);

    if (!VAPID_PUBLIC_KEY) {
      setFeedback({
        tone: "error",
        text: "Notifications are not configured on the server yet.",
      });
      return;
    }

    setWorking(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPhase("denied");
        setFeedback({
          tone: "error",
          text: "Notifications are blocked. Allow them in your browser settings.",
        });
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(
            VAPID_PUBLIC_KEY
          ) as BufferSource,
        });
      }

      const json = subscription.toJSON();
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: {
            p256dh: json.keys?.p256dh ?? "",
            auth: json.keys?.auth ?? "",
          },
        }),
      });

      if (!response.ok) {
        throw new Error("Could not save the subscription.");
      }

      setPhase("on");
      setFeedback({ tone: "ok", text: "Notifications are on for this device." });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not turn on notifications.",
      });
    } finally {
      setWorking(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setFeedback(null);
    setWorking(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration
        ? await registration.pushManager.getSubscription()
        : null;

      if (subscription) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      setPhase("off");
      setFeedback({ tone: "info", text: "Notifications are off for this device." });
    } catch {
      setFeedback({
        tone: "error",
        text: "Could not turn notifications off. Please try again.",
      });
    } finally {
      setWorking(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setFeedback(null);
    setTesting(true);
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      const result = (await response.json()) as {
        sent?: number;
        skipped?: string;
        subscriptions?: number;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(result.error ?? "Could not send the test notification.");
      }
      if (result.skipped === "no-subscriptions" || result.sent === 0) {
        setFeedback({
          tone: "info",
          text: "No device is subscribed yet. Tap Enable notifications first.",
        });
        return;
      }
      setFeedback({
        tone: "ok",
        text: "Sent. Check your notification tray — it may take a few seconds.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not send the test notification.",
      });
    } finally {
      setTesting(false);
    }
  }, []);

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[17px] font-semibold text-slate-900">
            Dose reminders
          </p>
          <p className="text-[15px] text-slate-500">
            Get a push for every dose, with Taken, Skip, and Snooze buttons.
          </p>
        </div>
        <StatusPill phase={phase} />
      </div>

      {showIosHint && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[15px] text-amber-900">
          On iPhone, tap <strong>Share</strong> &gt;{" "}
          <strong>Add to Home Screen</strong> first, then enable notifications.
        </div>
      )}

      {phase === "unsupported" && (
        <p className="text-[15px] text-slate-500">
          This browser does not support notifications. On iPhone, add MedScan to
          your Home Screen first.
        </p>
      )}

      {phase !== "loading" && phase !== "unsupported" && (
        <div className="space-y-2">
          {phase === "on" ? (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={working}
              onClick={disable}
            >
              {working ? "Turning off..." : "Turn off notifications"}
            </Button>
          ) : (
            <Button
              type="button"
              className="w-full"
              disabled={working}
              onClick={enable}
            >
              {working ? "Enabling..." : "Enable notifications"}
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={testing || phase !== "on"}
            onClick={sendTest}
          >
            {testing ? "Sending..." : "Send me a test notification"}
          </Button>
        </div>
      )}

      {feedback && (
        <p
          className={`text-[15px] ${
            feedback.tone === "error"
              ? "text-red-700"
              : feedback.tone === "ok"
                ? "text-primary-700"
                : "text-slate-500"
          }`}
          role="status"
        >
          {feedback.text}
        </p>
      )}
    </Card>
  );
}

function StatusPill({ phase }: { phase: Phase }) {
  const label: Record<Phase, string> = {
    loading: "Checking...",
    unsupported: "Unsupported",
    off: "Off",
    on: "On",
    denied: "Blocked",
  };

  const tone: Record<Phase, string> = {
    loading: "bg-slate-100 text-slate-600",
    unsupported: "bg-slate-100 text-slate-600",
    off: "bg-slate-100 text-slate-600",
    on: "bg-primary-100 text-primary-800",
    denied: "bg-red-100 text-red-700",
  };

  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-bold ${tone[phase]}`}
    >
      {label[phase]}
    </span>
  );
}
