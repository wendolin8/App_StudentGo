/*
# Allow administrative profiles without student identity fields

1. Purpose
- Keep administrative accounts separate from student records.
- Remove the artificial student identity currently stored on the existing ADMIN profile.

2. Modified table
- `public.profiles.student_number`: change from required to optional. Student profiles still receive a real matrícula through the student registration flow, while ADMIN profiles may remain NULL.
- `public.profiles` ADMIN row for `studentgo.admin@gmail.com`: set the display name to `Administrador Student Go` and clear the artificial matrícula.

3. Data safety
- No auth.users row is deleted or changed.
- No student profile or student data is modified.
- The ADMIN role, profile ID, email, permissions, and RLS policies remain unchanged.
- The existing unique constraint remains; PostgreSQL permits multiple NULL values, so administrative profiles do not consume student matrícula values.

4. Security
- Role and verification fields remain protected from normal client updates.
- This migration only changes the requiredness of the student-only identity field and updates the one existing ADMIN profile by exact authenticated email.
*/

ALTER TABLE public.profiles
  ALTER COLUMN student_number DROP NOT NULL;

UPDATE public.profiles AS p
SET full_name = 'Administrador Student Go',
    student_number = NULL,
    updated_at = now()
FROM auth.users AS u
WHERE p.id = u.id
  AND lower(u.email) = lower('studentgo.admin@gmail.com')
  AND p.role = 'ADMIN';