"use client";

import { useEffect, useMemo, useRef } from "react";
import { Card } from "@/components/ui";

export function ImageSlot({
  label,
  hint,
  required = false,
  file,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file]
  );

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    if (chosen) onChange(chosen);
    event.target.value = "";
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-medium text-slate-700">
          {label}
          {required ? (
            <span className="ml-1 text-red-500">*</span>
          ) : (
            <span className="ml-1 text-slate-400">(optional)</span>
          )}
        </span>
        {file && (
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className="text-[14px] font-semibold text-red-600 disabled:opacity-60"
          >
            Remove
          </button>
        )}
      </div>

      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt={label}
          className="h-40 w-full rounded-xl border border-slate-200 object-cover"
        />
      ) : (
        <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-slate-300 text-[15px] text-slate-400">
          No image yet
        </div>
      )}

      {hint && <p className="text-sm text-slate-400">{hint}</p>}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => cameraRef.current?.click()}
          className="min-h-[48px] rounded-xl bg-primary-600 px-4 text-[16px] font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
        >
          Camera
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => galleryRef.current?.click()}
          className="min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 text-[16px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          Gallery
        </button>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={pick}
        className="hidden"
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        onChange={pick}
        className="hidden"
      />
    </Card>
  );
}
