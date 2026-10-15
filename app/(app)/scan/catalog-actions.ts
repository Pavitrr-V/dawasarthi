"use server";

import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** A reference-data row from medicine_catalog matched by product name. */
export type CatalogMatch = {
  id: string;
  name: string;
  composition: string[];
  manufacturer: string | null;
  /** pg_trgm similarity score, 0..1. */
  similarity: number;
};

type CatalogRow = {
  id?: unknown;
  name?: unknown;
  composition?: unknown;
  manufacturer?: unknown;
  similarity?: unknown;
};

/**
 * Fuzzy-matches a name against medicine_catalog using the pg_trgm
 * `search_medicine_catalog` RPC (similarity >= 0.5, best match first).
 *
 * medicine_catalog has no barcode column, so this is the only way a scanned
 * barcode can be resolved to a known medicine. Every failure (no session, RPC
 * missing because the migration has not been applied, network error) returns
 * null so the caller can fall back to photo OCR.
 */
export async function lookupCatalogByName(
  name: string
): Promise<CatalogMatch | null> {
  const term = name.trim();
  if (term.length < 3) return null;

  const user = await getCurrentUser();
  if (!user) return null;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("search_medicine_catalog", {
      p_query: term,
      p_threshold: 0.5,
      p_limit: 1,
    });

    if (error || !Array.isArray(data) || data.length === 0) return null;

    const row = data[0] as CatalogRow;
    if (!row || typeof row.name !== "string" || row.name.trim().length === 0) {
      return null;
    }

    return {
      id: typeof row.id === "string" ? row.id : "",
      name: row.name.trim(),
      composition: Array.isArray(row.composition)
        ? row.composition.filter(
            (item): item is string => typeof item === "string"
          )
        : [],
      manufacturer:
        typeof row.manufacturer === "string" && row.manufacturer.trim().length > 0
          ? row.manufacturer.trim()
          : null,
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
    };
  } catch {
    return null;
  }
}
