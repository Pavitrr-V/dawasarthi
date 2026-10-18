"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Html5Qrcode } from "html5-qrcode";
import { Button, Card, Field, Input } from "@/components/ui";
import { isValidInviteCode, joinPath, normalizeInviteCode } from "@/lib/caregiver";

const SCANNER_ID = "medscan-qr-scanner";

/** Pull an invite code out of a scanned QR payload (a URL or a raw code). */
function extractCode(text: string): string {
  const trimmed = text.trim();
  const param = trimmed.match(/[?&]code=([A-Za-z0-9]+)/);
  if (param) return normalizeInviteCode(param[1]);
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (code) return normalizeInviteCode(code);
  } catch {
    // Not a URL; fall through and treat the text as the code itself.
  }
  return normalizeInviteCode(trimmed);
}

/** Code entry + optional QR scan. Used when no valid code is in the URL. */
export function JoinEntry({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialCode);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    return () => {
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner) {
        scanner.stop().catch(() => {}).finally(() => scanner.clear());
      }
    };
  }, []);

  function go(code: string) {
    if (!isValidInviteCode(code)) {
      setError("Enter the 8-character invite code.");
      return;
    }
    router.push(joinPath(code));
  }

  async function startScan() {
    setError(null);
    setScanning(true);
    try {
      const { Html5Qrcode: Scanner } = await import("html5-qrcode");
      const scanner = new Scanner(SCANNER_ID);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 240 },
        (decoded) => {
          const code = extractCode(decoded);
          scanner.stop().catch(() => {}).finally(() => scanner.clear());
          scannerRef.current = null;
          setScanning(false);
          if (isValidInviteCode(code)) go(code);
          else setError("That QR code is not a MedScan invite.");
        },
        () => {
          // Per-frame decode errors are expected; ignore them.
        }
      );
    } catch {
      setScanning(false);
      scannerRef.current = null;
      setError("Could not open the camera. Enter the code instead.");
    }
  }

  function stopScan() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    setScanning(false);
    if (scanner) {
      scanner.stop().catch(() => {}).finally(() => scanner.clear());
    }
  }

  return (
    <Card className="space-y-4">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          go(normalizeInviteCode(value));
        }}
      >
        <Field label="Invite code" hint="8 characters, e.g. K7M2P9QT">
          <Input
            value={value}
            onChange={(event) => {
              setValue(normalizeInviteCode(event.target.value));
              setError(null);
            }}
            placeholder="ABCD2345"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={8}
            className="text-center text-2xl tracking-[0.3em] uppercase"
          />
        </Field>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
            {error}
          </div>
        )}

        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>

      <div className="flex items-center gap-3 text-sm text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        or
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      {!scanning ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={startScan}
        >
          Scan QR code
        </Button>
      ) : (
        <div className="space-y-3">
          <div id={SCANNER_ID} className="overflow-hidden rounded-xl bg-slate-100" />
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={stopScan}
          >
            Stop scanning
          </Button>
        </div>
      )}
    </Card>
  );
}
