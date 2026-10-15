create policy "users upload own images"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'medicine-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "users read own images"
on storage.objects for select to authenticated
using (
  bucket_id = 'medicine-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "users delete own images"
on storage.objects for delete to authenticated
using (
  bucket_id = 'medicine-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);