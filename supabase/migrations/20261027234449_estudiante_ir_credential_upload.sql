/*
# Estudiante Ir: documento de credencial estudiantil

1. Cambio de datos
- Agrega `credential_path` a `profiles` para guardar la ruta privada de la imagen de credencial.

2. Seguridad
- El archivo se guarda en el bucket privado `student-documents` dentro de la carpeta del usuario.
- El usuario solo puede escribir la ruta de su propio documento; la verificación no se modifica desde el navegador.
*/

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS credential_path text;
GRANT UPDATE (credential_path) ON public.profiles TO authenticated;
