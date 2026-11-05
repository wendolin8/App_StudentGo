/*
# Admin announcements

1. Purpose
- Provide a private, durable place for Student Go administrators to create and manage operational notices.

2. New table
- `public.admin_announcements`
- `id`: unique announcement identifier.
- `title`: short notice title.
- `message`: notice body.
- `type`: operational category such as GENERAL, SAFETY, or MAINTENANCE.
- `published`: whether the notice is active.
- `created_by`: ADMIN profile that created it.
- `created_at` and `updated_at`: audit timestamps.

3. Security changes
- RLS is enabled.
- Only authenticated callers whose functional role is ADMIN can read, create, update, or delete announcements.
- The creator is taken from `auth.uid()` by default and cannot be changed through the client insert policy.
- No anonymous access is granted.

4. Important notes
- The Supabase `authenticated` session role is not enough to use this table; every policy also requires `public.is_admin()`.
- This table does not change student roles, driver approval, or credential verification.
*/

CREATE TABLE IF NOT EXISTS public.admin_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 3 AND 2000),
  type text NOT NULL DEFAULT 'GENERAL' CHECK (type IN ('GENERAL', 'SAFETY', 'MAINTENANCE')),
  published boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_announcements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_announcements TO authenticated;

DROP POLICY IF EXISTS "admin_announcements_select_admin" ON public.admin_announcements;
CREATE POLICY "admin_announcements_select_admin" ON public.admin_announcements
FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "admin_announcements_insert_admin" ON public.admin_announcements;
CREATE POLICY "admin_announcements_insert_admin" ON public.admin_announcements
FOR INSERT TO authenticated WITH CHECK (public.is_admin() AND created_by = auth.uid());

DROP POLICY IF EXISTS "admin_announcements_update_admin" ON public.admin_announcements;
CREATE POLICY "admin_announcements_update_admin" ON public.admin_announcements
FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin() AND created_by = auth.uid());

DROP POLICY IF EXISTS "admin_announcements_delete_admin" ON public.admin_announcements;
CREATE POLICY "admin_announcements_delete_admin" ON public.admin_announcements
FOR DELETE TO authenticated USING (public.is_admin());