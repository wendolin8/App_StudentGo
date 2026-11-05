/*
# Estudiante Ir: frente y reverso de credencial

1. Nuevas columnas
- `credential_front_path`: imagen privada del frente.
- `credential_back_path`: imagen privada del reverso.

2. Seguridad
- Solo el propietario autenticado puede guardar las rutas de sus imágenes.
- Las imágenes viven en el bucket privado y sus rutas no son públicas.
*/

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS credential_front_path text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS credential_back_path text;
GRANT UPDATE (credential_front_path, credential_back_path) ON public.profiles TO authenticated;
