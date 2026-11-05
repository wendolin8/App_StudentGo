/*
# Admin dashboard read access

1. Purpose
- Allow the existing functional ADMIN role to load the data needed by its private dashboard.
- Keep students and drivers limited to their own profile and safety records.

2. Modified tables and policies
- `public.profiles`: add an ADMIN-only SELECT policy so administrators can review student identity and UTP verification status.
- `public.sos_alerts`: add an ADMIN-only SELECT policy so administrators can monitor active and historical safety incidents.

3. Security changes
- Access is checked with `public.is_admin()`, which derives authorization from the caller's `public.profiles.role` and `auth.uid()`.
- No write permissions are added. Administrators can read these dashboard datasets but cannot change a user's role or verification state through the Data API.
- Existing ownership policies remain unchanged.

4. Important notes
- Supabase's `authenticated` role only means the session is signed in; it is not the Student Go ADMIN role.
- OCR remains a test flow and does not set `student_verified`.
*/

DROP POLICY IF EXISTS "profiles_select_admin" ON public.profiles;
CREATE POLICY "profiles_select_admin" ON public.profiles
FOR SELECT TO authenticated
USING (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "sos_alerts_select_admin" ON public.sos_alerts;
CREATE POLICY "sos_alerts_select_admin" ON public.sos_alerts
FOR SELECT TO authenticated
USING (public.is_admin());