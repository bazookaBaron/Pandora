-- 51_avatars_no_list_security.sql
-- sql/15 gave the public `avatars` bucket a SELECT policy for everyone, which lets any client LIST
-- (enumerate) every user's avatar paths via the storage API. Public object URLs
-- (/storage/v1/object/public/avatars/...) are served by the bucket's public flag and do NOT need it.
DROP POLICY IF EXISTS "avatars_read" ON storage.objects;

-- Owners keep SELECT on their own folder (needed for upsert/replace and for listing their own files).
DROP POLICY IF EXISTS "avatars_read_own" ON storage.objects;
CREATE POLICY "avatars_read_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
