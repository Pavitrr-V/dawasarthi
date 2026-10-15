import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Buckets to clean up when a user deletes all of their data, configured via
 * the comma-separated MEDSCAN_STORAGE_BUCKETS env var (names only, no secrets).
 * When unset, storage cleanup is skipped and we rely on the
 * delete_all_my_data() RPC to clear the storage metadata rows.
 */
export function configuredStorageBuckets(): string[] {
  return (process.env.MEDSCAN_STORAGE_BUCKETS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

async function listAllPaths(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const paths: string[] = [];
  const queue = [prefix];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(current, { limit: 1000 });
    if (error || !data) continue;

    for (const item of data) {
      const path = current ? `${current}/${item.name}` : item.name;
      // Folders are returned with a null id; recurse into them.
      if (item.id === null) queue.push(path);
      else paths.push(path);
    }
  }

  return paths;
}

/**
 * Best-effort removal of a user's uploaded files from every configured bucket.
 * Files live under the owner id and each patient id prefix. Never throws;
 * failures fall through to the delete_all_my_data() RPC metadata cleanup.
 */
export async function removeUserStorage(
  supabase: SupabaseClient,
  userId: string,
  patientIds: string[]
): Promise<void> {
  const buckets = configuredStorageBuckets();
  if (buckets.length === 0) return;

  const prefixes = [userId, ...patientIds];

  for (const bucket of buckets) {
    for (const prefix of prefixes) {
      try {
        const paths = await listAllPaths(supabase, bucket, prefix);
        if (paths.length > 0) {
          await supabase.storage.from(bucket).remove(paths);
        }
      } catch {
        // Ignore: cleanup is best-effort.
      }
    }
  }
}
