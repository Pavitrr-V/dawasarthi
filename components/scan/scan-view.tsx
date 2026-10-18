"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { compressImage } from "@/lib/image";
import { DISCLAIMER, MEDICINE_IMAGES_BUCKET } from "@/lib/constants";
import { EMPTY_EXTRACTION, saveReviewPayload } from "@/lib/review";
import { savePrescriptionReviewPayload } from "@/lib/prescription-review";
import type { PrescriptionExtraction } from "@/lib/prescription";
import { nameHintFromScan, parseGs1 } from "@/lib/gs1";
import { lookupCatalogByName } from "@/app/(app)/scan/catalog-actions";
import { Button, Card } from "@/components/ui";
import { ImageSlot } from "@/components/scan/image-slot";
import { BarcodeScanner } from "@/components/scan/barcode-scanner";
import { ManualEntryForm } from "@/components/scan/manual-entry-form";
import { ResultCard } from "@/components/scan/result-card";
import type { ExtractionResult, MedicineExtraction, ScanMode } from "@/lib/extraction";

type Phase = "idle" | "uploading" | "extracting" | "done" | "error";

const MODES: { value: ScanMode; label: string }[] = [
  { value: "medicine", label: "Medicine" },
  { value: "prescription", label: "Prescription" },
  { value: "barcode", label: "Barcode" },
];

function isSplit(
  value: ExtractionResult
): value is { strip: MedicineExtraction | null; box: MedicineExtraction | null } {
  return "strip" in value || "box" in value;
}

export function ScanView({ userId }: { userId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<ScanMode>("medicine");
  const [strip, setStrip] = useState<File | null>(null);
  const [box, setBox] = useState<File | null>(null);
  const [single, setSingle] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [showManual, setShowManual] = useState(false);
  /** Barcode flow: true while we resolve a scanned code. */
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  /** Barcode flow: did the code match medicine_catalog? (Phase 3 AMBER flag) */
  const [datasetMatch, setDatasetMatch] = useState<boolean | undefined>();
  /** Shown after a barcode falls back to photo OCR. */
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);

  const working = phase === "uploading" || phase === "extracting";
  const busy = working || barcodeBusy;

  function filesForMode(): File[] {
    if (mode === "medicine") return [strip, box].filter(Boolean) as File[];
    return [single].filter(Boolean) as File[];
  }

  const hasRequired = mode === "medicine" ? strip !== null : single !== null;

  function reset() {
    setStrip(null);
    setBox(null);
    setSingle(null);
    setResult(null);
    setPaths([]);
    setError(null);
    setShowManual(false);
    setPhase("idle");
    setBarcodeBusy(false);
    setDatasetMatch(undefined);
    setFallbackNote(null);
  }

  function selectMode(next: ScanMode) {
    if (working || next === mode) return;
    setMode(next);
    setResult(null);
    setError(null);
    setShowManual(false);
    setPhase("idle");
    setBarcodeBusy(false);
    setDatasetMatch(undefined);
    setFallbackNote(null);
  }

  /**
   * A barcode could not be turned into a known medicine: switch to the photo
   * flow and remember that the dataset did not match (Phase 3 AMBER flag).
   */
  function fallBackToPhoto(message: string) {
    selectMode("medicine");
    setDatasetMatch(false);
    setFallbackNote(message);
  }

  async function runScan() {
    const files = filesForMode();
    if (files.length === 0) {
      setError("Add a photo first.");
      setPhase("error");
      return;
    }

    setError(null);
    setResult(null);
    setShowManual(false);

    try {
      const supabase = createClient();
      const uploaded: string[] = [];

      setPhase("uploading");
      for (const file of files) {
        const blob = await compressImage(file);
        const path = `${userId}/${crypto.randomUUID()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from(MEDICINE_IMAGES_BUCKET)
          .upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (uploadError) {
          throw new Error(
            "We could not upload your photo. Check your connection and try again."
          );
        }
        uploaded.push(path);
      }
      setPaths(uploaded);

      setPhase("extracting");
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, paths: uploaded }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ExtractionResult
        | { error?: string }
        | null;

      if (!response.ok || !payload || ("error" in payload && payload.error)) {
        throw new Error(
          (payload && "error" in payload && payload.error) ||
            "We could not read this photo. Please try again."
        );
      }

      setResult(payload as ExtractionResult);
      setPhase("done");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Something went wrong. Please try again."
      );
      setPhase("error");
    }
  }

  /**
   * Hand the extraction to /scan/review (sessionStorage) so the user can fix
   * low-confidence fields before anything is saved.
   */
  function goToReview() {
    if (!result) return;

    // Prescription mode returns a completely different shape (a list of
    // medicine lines), so it gets its own review screen.
    if (mode === "prescription") {
      const prescription = result as unknown as PrescriptionExtraction;
      if (!prescription || !Array.isArray(prescription.medicines) || prescription.medicines.length === 0) {
        setError(
          "We could not read this prescription. Try a sharper photo or enter the medicines manually."
        );
        setPhase("error");
        return;
      }
      savePrescriptionReviewPayload({ extraction: prescription, imagePaths: paths });
      router.push("/scan/prescription/review");
      return;
    }

    // Two photos come back as strip + box, but the review form edits a single
    // medicine, so prefer the strip reading and fall back to the box.
    const extraction = isSplit(result)
      ? result.strip ?? result.box
      : result;

    if (!extraction) {
      setError(
        "We could not read these photos clearly. Enter the details manually."
      );
      setPhase("error");
      return;
    }

    saveReviewPayload({ extraction, mode, imagePaths: paths, datasetMatch });
    router.push("/scan/review");
  }

  /**
   * A barcode was decoded. Prefer a medicine_catalog match (by fuzzy name),
   * then prefill batch/expiry from GS1. Anything else falls back to photo OCR.
   */
  async function handleBarcode(text: string) {
    if (barcodeBusy) return;
    setBarcodeBusy(true);
    setError(null);
    setFallbackNote(null);

    try {
      const parsed = parseGs1(text);
      const nameHint = nameHintFromScan(text);
      // medicine_catalog has no barcode column: only a name can be matched.
      const match = nameHint ? await lookupCatalogByName(nameHint) : null;
      const matched = match !== null;

      const extraction: MedicineExtraction = {
        ...EMPTY_EXTRACTION,
        name: match?.name ?? null,
        composition:
          match?.composition.map((ingredient) => ({
            ingredient,
            strength: null,
          })) ?? [],
        manufacturer: match?.manufacturer ?? null,
        batch_no: parsed.batch,
        expiry_date: parsed.expiry,
        barcode_text: parsed.gtin,
        date_precision: parsed.expiryPrecision,
        confidence: {
          ...(match
            ? { name: 0.8, composition: match.composition.length > 0 ? 0.8 : 0.5 }
            : {}),
          ...(match?.manufacturer ? { manufacturer: 0.75 } : {}),
          ...(parsed.batch ? { batch_no: 0.9 } : {}),
          ...(parsed.expiry ? { expiry_date: 0.95 } : {}),
          ...(parsed.gtin ? { barcode_text: 0.95 } : {}),
        },
      };

      // A match, or GS1 batch/expiry, is worth reviewing.
      if (matched || parsed.batch || parsed.expiry) {
        saveReviewPayload({
          extraction,
          mode: "barcode",
          imagePaths: [],
          datasetMatch: matched,
        });
        router.push("/scan/review");
        return;
      }

      // A plain EAN/UPC with no name to match: fall back to photo OCR.
      fallBackToPhoto(
        "We read the barcode, but it did not include a product name or expiry date. Take a photo of the medicine instead."
      );
    } catch {
      fallBackToPhoto(
        "We could not process that barcode. Take a photo of the medicine instead."
      );
    }
  }

  if (phase === "done" && result) {
    if (mode === "prescription") {
      const prescription = result as unknown as PrescriptionExtraction;
      return (
        <div className="space-y-4">
          <Card className="space-y-2">
            <p className="text-[17px] font-semibold text-slate-900">
              Prescription read
            </p>
            <p className="text-[15px] text-slate-600">
              {prescription.doctor_name ? `Dr. ${prescription.doctor_name.replace(/^Dr\.?\s*/i, "")} · ` : ""}
              {prescription.medicines.length} medicine{prescription.medicines.length === 1 ? "" : "s"} found
            </p>
            <ul className="space-y-1">
              {prescription.medicines.map((med, index) => (
                <li key={index} className="text-[15px] text-slate-700">
                  {med.name || med.raw_text}
                  {med.pattern ? ` · ${med.pattern}` : ""}
                  {med.timing ? ` · ${med.timing.replace("_", " ")}` : ""}
                </li>
              ))}
            </ul>
          </Card>
          <Button type="button" className="w-full" onClick={goToReview}>
            Review &amp; save
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={reset}
          >
            Scan another
          </Button>
          <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {isSplit(result) ? (
          <>
            <ResultCard title="Strip" data={result.strip} />
            <ResultCard title="Box" data={result.box} />
          </>
        ) : (
          <ResultCard data={result} />
        )}
        <Button type="button" className="w-full" onClick={goToReview}>
          Review &amp; save
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={reset}
        >
          Scan another
        </Button>
        <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
      </div>
    );
  }

  if (showManual) {
    return (
      <ManualEntryForm
        onSubmit={(extraction) => {
          setResult(extraction);
          setShowManual(false);
          setPhase("done");
        }}
        onCancel={() => {
          setShowManual(false);
          setError(null);
          setPhase("idle");
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
        {MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={busy}
            onClick={() => selectMode(option.value)}
            className={`min-h-[44px] rounded-lg px-1 text-[15px] font-semibold transition-colors disabled:opacity-60 ${
              mode === option.value
                ? "bg-white text-primary-700 shadow-sm"
                : "text-slate-500"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {fallbackNote && mode !== "barcode" && (
        <Card className="space-y-1 border-amber-200 bg-amber-50">
          <p className="text-[15px] font-medium text-amber-900">
            Barcode not recognised
          </p>
          <p className="text-[15px] text-amber-800">{fallbackNote}</p>
        </Card>
      )}

      {mode === "barcode" ? (
        barcodeBusy ? (
          <BarcodeChecking />
        ) : (
          <BarcodeScanner
            onDecoded={handleBarcode}
            onUsePhoto={() =>
              fallBackToPhoto(
                "Take a photo of the medicine instead and we will read it."
              )
            }
          />
        )
      ) : mode === "medicine" ? (
        <div className="space-y-3">
          <ImageSlot
            label="Front / Strip"
            required
            file={strip}
            onChange={setStrip}
            disabled={busy}
          />
          <ImageSlot
            label="Back / Box"
            file={box}
            onChange={setBox}
            disabled={busy}
          />
        </div>
      ) : (
        <ImageSlot
          label="Prescription photo"
          required
          hint="Include the whole prescription if you can."
          file={single}
          onChange={setSingle}
          disabled={busy}
        />
      )}

      {working && <ScanSkeleton label={phase} />}

      {phase === "error" && error && (
        <Card className="space-y-3 border-red-200 bg-red-50">
          <p className="text-[15px] text-red-700">{error}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              onClick={() => {
                setShowManual(true);
                setError(null);
                setPhase("idle");
              }}
            >
              Enter manually
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={runScan}
              disabled={!hasRequired}
            >
              Try again
            </Button>
          </div>
        </Card>
      )}

      {mode !== "barcode" && (
        <Button
          type="button"
          className="w-full"
          onClick={runScan}
          disabled={!hasRequired || busy}
        >
          {working ? "Scanning..." : "Scan"}
        </Button>
      )}

      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>

      {phase !== "error" && (
        <button
          type="button"
          onClick={() => router.push("/scan/manual")}
          disabled={busy}
          className="w-full py-1 text-center text-[15px] font-semibold text-primary-700 disabled:opacity-60"
        >
          Enter details manually instead
        </button>
      )}
    </div>
  );
}

function BarcodeChecking() {
  return (
    <Card className="space-y-3">
      <p className="text-[15px] font-medium text-primary-700">
        Checking the code…
      </p>
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-2/3 rounded bg-slate-200" />
        <div className="h-4 w-1/2 rounded bg-slate-200" />
        <div className="h-4 w-3/4 rounded bg-slate-200" />
      </div>
    </Card>
  );
}

function ScanSkeleton({ label }: { label: "uploading" | "extracting" }) {
  const text =
    label === "uploading"
      ? "Compressing and uploading your photos…"
      : "Reading the label and extracting details…";
  return (
    <Card className="space-y-3">
      <p className="text-[15px] font-medium text-primary-700">{text}</p>
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-2/3 rounded bg-slate-200" />
        <div className="h-4 w-1/2 rounded bg-slate-200" />
        <div className="h-4 w-3/4 rounded bg-slate-200" />
        <div className="h-4 w-1/3 rounded bg-slate-200" />
      </div>
    </Card>
  );
}
