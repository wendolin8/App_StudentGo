/*
# Estudiante Ir: creación automática del perfil de usuario

1. Objetivo
- Crear el perfil de la aplicación al crear una cuenta en Supabase Auth.
- Permitir que el registro funcione aunque la confirmación de correo esté activa.

2. Seguridad
- La función usa `SECURITY DEFINER` con `search_path` fijo.
- Solo se ejecuta como trigger interno de `auth.users`.
- Se revoca su ejecución directa para los roles públicos y autenticados.
- Los datos administrativos conservan sus valores por defecto.

3. Datos usados
- `full_name` y `student_number` se leen de los metadatos enviados durante el registro.
- El correo proviene de `auth.users`, no del formulario como fuente de autorización.
*/

CREATE OR REPLACE FUNCTION public.handle_new_student_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, student_number)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), 'Estudiante UTP'),
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'student_number', ''), 'PENDIENTE-' || replace(NEW.id::text, '-', ''))
  )
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_student_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_student_profile
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_student_profile();

REVOKE EXECUTE ON FUNCTION public.handle_new_student_profile() FROM PUBLIC, anon, authenticated;
