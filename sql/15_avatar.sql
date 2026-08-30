-- ============================================================================
-- 15_avatar.sql — profile avatars
--   • profiles.avatar_url column
--   • capture the Google profile picture on signup (handle_new_user)
--   • public `avatars` storage bucket + own-folder write RLS
--   • backfill existing Google users
-- Idempotent. Run in the Supabase SQL Editor AFTER sql/11.
-- ============================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;

-- ── signup trigger: also grab the OAuth avatar (Google puts it under
--    `avatar_url`; some providers use `picture`) ────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  raw jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  yoe_txt text := NULLIF(trim(raw->>'years_of_experience'), '');
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status, provider)
  VALUES (NEW.id, 'free', 'active', NULL)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.profiles (id, company, position, years_of_experience, avatar_url)
  VALUES (
    NEW.id,
    NULLIF(trim(raw->>'company'), ''),
    NULLIF(trim(raw->>'position'), ''),
    CASE WHEN yoe_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN yoe_txt::numeric ELSE NULL END,
    NULLIF(trim(COALESCE(raw->>'avatar_url', raw->>'picture')), '')
  )
  ON CONFLICT (id) DO UPDATE
    SET avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── public `avatars` bucket ─────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152,
        ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

-- Anyone can read (bucket is public); a user may write/replace/remove only
-- files under a top-level folder named for their own uid.
DROP POLICY IF EXISTS "avatars_read" ON storage.objects;
CREATE POLICY "avatars_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
CREATE POLICY "avatars_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;
CREATE POLICY "avatars_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── backfill: pull the Google picture for existing users ────────────────────
UPDATE public.profiles p
SET avatar_url = NULLIF(trim(COALESCE(
      u.raw_user_meta_data->>'avatar_url',
      u.raw_user_meta_data->>'picture')), '')
FROM auth.users u
WHERE u.id = p.id
  AND p.avatar_url IS NULL
  AND COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture') IS NOT NULL;
