"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { compressImage } from "@/lib/image";
import { DISCLAIMER, MEDICINE_IMAGES_BUCKET } from "@/lib/constants";
import { Button, Card } from "@/components/ui";
import { ImageSlot } from "@/components/scan/image-slot";
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
  const [mode, setMode] = useState<ScanMode>("medicine");
  const [strip, setStrip] = useState<File | null>(null);
  const [box, setBox] = useState<File | null>(null);
  const [single, setSingle] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [showManual, setShowManual] = useState(false);

  const working = phase === "uploading" || phase === "extracting";

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
    setError(null);
    setShowManual(false);
    setPhase("idle");
  }

  function selectMode(next: ScanMode) {
    if (working || next === mode) return;
    setMode(next);
    setResult(null);
    setError(null);
    setShowManual(false);
    setPhase("idle");
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
      const paths: string[] = [];

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
        paths.push(path);
      }

      setPhase("extracting");
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, paths }),
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

  if (phase === "done" && result) {
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
        <Button type="button" className="w-full" onClick={reset}>
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
            disabled={working}
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

      {mode === "medicine" ? (
        <div className="space-y-3">
          <ImageSlot
            label="Front / Strip"
            required
            file={strip}
            onChange={setStrip}
            disabled={working}
          />
          <ImageSlot
            label="Back / Box"
            file={box}
            onChange={setBox}
            disabled={working}
          />
        </div>
      ) : (
        <ImageSlot
          label={mode === "prescription" ? "Prescription photo" : "Barcode photo"}
          required
          hint={
            mode === "barcode"
              ? "Line up the barcode inside the frame."
              : "Include the whole prescription if you can."
          }
          file={single}
          onChange={setSingle}
          disabled={working}
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

      <Button
        type="button"
        className="w-full"
        onClick={runScan}
        disabled={!hasRequired || working}
      >
        {working ? "Scanning..." : "Scan"}
      </Button>

      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>

      {phase !== "error" && (
        <button
          type="button"
          onClick={() => {
            setShowManual(true);
            setError(null);
            setPhase("idle");
          }}
          disabled={working}
          className="w-full py-1 text-center text-[15px] font-semibold text-primary-700 disabled:opacity-60"
        >
          Enter details manually instead
        </button>
      )}
    </div>
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
