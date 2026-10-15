"use client";

import { useEffect, useRef, useState } from "react";
import type { Html5Qrcode } from "html5-qrcode";
import { Button, Card } from "@/components/ui";

type ScannerStatus = "starting" | "running" | "denied" | "error";

/** Element html5-qrcode renders its live <video> preview into. */
const READER_ID = "medscan-barcode-reader";

function isPermissionDenied(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /NotAllowedError|PermissionDeniedError|SecurityError|Permission|denied/i.test(
    `${name} ${message}`
  );
}

/** Stop the camera and clear the preview element. Never throws. */
async function stopScanner(instance: Html5Qrcode | null): Promise<void> {
  if (!instance) return;
  try {
    await instance.stop();
  } catch {
    // Never started, or already stopped.
  }
  try {
    instance.clear();
  } catch {
    // Preview element already cleared.
  }
}

/**
 * Live rear-camera barcode / QR scanner (html5-qrcode).
 *
 * The library is imported dynamically so it never runs during SSR. The camera
 * is stopped on unmount and after the first successful decode; the intercepted
 * frame is then handed to `onDecoded` exactly once.
 */
export function BarcodeScanner({
  onDecoded,
  onUsePhoto,
}: {
  /** Called once with the first decoded payload, after the camera stops. */
  onDecoded: (text: string) => void;
  /** Switch to the photo-OCR flow. */
  onUsePhoto: () => void;
}) {
  const [status, setStatus] = useState<ScannerStatus>("starting");
  const [attempt, setAttempt] = useState(0);
  const handledRef = useRef(false);
  const onDecodedRef = useRef(onDecoded);

  // Keep the latest callback without restarting the camera on every render.
  useEffect(() => {
    onDecodedRef.current = onDecoded;
  }, [onDecoded]);

  useEffect(() => {
    let disposed = false;
    let instance: Html5Qrcode | null = null;

    async function boot() {
      try {
        const mod = await import("html5-qrcode");
        if (disposed) return;

        const scanner = new mod.Html5Qrcode(READER_ID, {
          formatsToSupport: [
            mod.Html5QrcodeSupportedFormats.EAN_13,
            mod.Html5QrcodeSupportedFormats.EAN_8,
            mod.Html5QrcodeSupportedFormats.UPC_A,
            mod.Html5QrcodeSupportedFormats.UPC_E,
            mod.Html5QrcodeSupportedFormats.CODE_128,
            mod.Html5QrcodeSupportedFormats.QR_CODE,
            mod.Html5QrcodeSupportedFormats.DATA_MATRIX,
          ],
          verbose: false,
        });
        instance = scanner;

        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const edge = Math.floor(
                Math.min(viewfinderWidth, viewfinderHeight) * 0.75
              );
              const size = Math.max(140, Math.min(edge, 320));
              return { width: size, height: size };
            },
          },
          (decodedText) => {
            if (disposed || handledRef.current) return;
            handledRef.current = true;
            void stopScanner(scanner).then(() => {
              if (!disposed) onDecodedRef.current(decodedText);
            });
          },
          () => {
            // Fires for every frame without a code. Expected; ignore.
          }
        );

        if (disposed) {
          await stopScanner(scanner);
          return;
        }
        setStatus("running");
      } catch (error) {
        if (instance) await stopScanner(instance);
        instance = null;
        if (disposed) return;
        setStatus(isPermissionDenied(error) ? "denied" : "error");
      }
    }

    void boot();

    return () => {
      disposed = true;
      void stopScanner(instance);
      instance = null;
    };
  }, [attempt]);

  if (status === "denied" || status === "error") {
    return (
      <Card className="space-y-3 border-amber-200 bg-amber-50">
        <p className="text-[15px] font-medium text-amber-900">
          {status === "denied"
            ? "Camera access is blocked."
            : "We could not start the camera."}
        </p>
        <p className="text-[15px] text-amber-800">
          {status === "denied"
            ? "Allow camera access for this site in your browser settings, then try again."
            : "Something went wrong opening the camera. Try again, or take a photo instead."}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            onClick={() => {
              handledRef.current = false;
              setStatus("starting");
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
          <Button type="button" variant="secondary" onClick={onUsePhoto}>
            Use photo instead
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-medium text-slate-700">
          Point the camera at the barcode
        </span>
        {status === "starting" && (
          <span className="text-sm text-slate-400">Starting camera…</span>
        )}
      </div>

      <div
        id={READER_ID}
        className="min-h-[240px] overflow-hidden rounded-xl bg-slate-900 [&_video]:w-full"
      />

      <p className="text-sm text-slate-400">
        Supports EAN-13, Code 128, QR and DataMatrix. Fill the frame and hold
        steady.
      </p>

      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={onUsePhoto}
      >
        Use photo instead
      </Button>
    </Card>
  );
}
