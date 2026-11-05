/*
# Estudiante Ir: endurecer privilegios del cliente

1. Objetivo
- Eliminar permisos heredados para `anon` en las tablas privadas de la aplicación.
- Reducir las columnas que el navegador puede insertar o modificar.

2. Cambios de seguridad
- `profiles`: solo permite insertar el perfil propio con campos de identidad y actualizar datos personales.
- `trips`: solo usuarios autenticados pueden operar; la propiedad del viaje sigue controlada por RLS.
- `trip_requests`: el cliente solo puede leer e insertar solicitudes propias; aceptar o rechazar queda reservado al backend.
- `notifications`: el cliente solo puede leer y marcar como leídas sus notificaciones.

3. Impacto
- No se eliminan datos ni columnas.
- Las decisiones de verificación, roles, estados administrativos y notificaciones creadas por el sistema no son editables desde el navegador.
*/

REVOKE ALL ON public.profiles FROM anon;
REVOKE DELETE ON public.profiles FROM authenticated;
REVOKE INSERT ON public.profiles FROM authenticated;
GRANT INSERT (id, email, full_name, student_number, phone, campus, career, avatar_path) ON public.profiles TO authenticated;

REVOKE ALL ON public.trips FROM anon;

REVOKE ALL ON public.trip_requests FROM anon;
REVOKE UPDATE, DELETE ON public.trip_requests FROM authenticated;

REVOKE ALL ON public.notifications FROM anon;
REVOKE INSERT, DELETE ON public.notifications FROM authenticated;
GRANT SELECT, UPDATE (read_at) ON public.notifications TO authenticated;
