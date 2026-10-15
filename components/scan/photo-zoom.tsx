"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { MEDICINE_IMAGES_BUCKET } from "@/lib/constants";

type Supabase = ReturnType<typeof createClient>;

const SIGNED_URL_ATTEMPTS = 3;

/** Signed-URL calls (and the session refresh behind them) can blip once in a
 *  while, so retry before showing the user "Photo unavailable". */
async function createSignedUrlWithRetry(
  supabase: Supabase,
  path: string
): Promise<string | null> {
  for (let attempt = 1; attempt <= SIGNED_URL_ATTEMPTS; attempt += 1) {
    try {
      const { data, error } = await supabase.storage
        .from(MEDICINE_IMAGES_BUCKET)
        .createSignedUrl(path, 60 * 60);
      if (data?.signedUrl) return data.signedUrl;
      console.warn(
        `[photo-zoom] signed url failed (${attempt}/${SIGNED_URL_ATTEMPTS})`,
        path,
        error?.message
      );
    } catch (error) {
      console.warn(
        `[photo-zoom] signed url threw (${attempt}/${SIGNED_URL_ATTEMPTS})`,
        path,
        error
      );
    }
    if (attempt < SIGNED_URL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  return null;
}

/**
 * Thumbnails of the photos the user scanned, so they can compare the form
 * against the original. Tap opens a full-screen zoom view. A missing URL is
 * just "still loading" (or "unavailable" once the signed URL call fails).
 */
export function PhotoZoom({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [zoomed, setZoomed] = useState<string | null>(null);

  const key = paths.join("|");

  useEffect(() => {
    if (paths.length === 0) return;
    let cancelled = false;
    const supabase = createClient();

    for (const path of paths) {
      createSignedUrlWithRetry(supabase, path).then((url) => {
        if (cancelled) return;
        if (!url) {
          setFailed((prev) => ({ ...prev, [path]: true }));
          return;
        }
        setUrls((prev) => ({ ...prev, [path]: url }));
      });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!zoomed) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setZoomed(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (paths.length === 0) return null;

  return (
    <section className="space-y-2">
      <span className="block text-[15px] font-medium text-slate-700">
        Your photo
        <span className="ml-2 text-sm font-normal text-slate-400">
          Tap to zoom
        </span>
      </span>

      <div className="flex gap-2">
        {paths.map((path) => {
          const ready = Boolean(urls[path]);
          return (
            <button
              key={path}
              type="button"
              onClick={() => setZoomed(path)}
              disabled={!ready}
              aria-label="Zoom photo"
              className={`h-24 w-24 overflow-hidden rounded-xl border transition-colors ${
                ready
                  ? "border-slate-300 hover:border-primary-400"
                  : "cursor-default border-slate-200 bg-slate-50"
              }`}
            >
              {ready ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={urls[path]}
                  alt="Scanned medicine"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-center text-[12px] text-slate-400">
                  {failed[path] ? "Photo unavailable" : "Loading…"}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {zoomed && urls[zoomed] && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Scanned photo"
          onClick={() => setZoomed(null)}
        >
          <button
            type="button"
            onClick={() => setZoomed(null)}
            aria-label="Close photo"
            className="absolute top-4 right-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-2xl text-white"
          >
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={urls[zoomed]}
            alt="Scanned medicine, zoomed"
            className="max-h-[85vh] w-full rounded-xl object-contain"
            onClick={(event) => event.stopPropagation()}
          />
          <p className="mt-3 text-sm text-white/70">
            Tap anywhere or press Esc to close
          </p>
        </div>
      )}
    </section>
  );
}
