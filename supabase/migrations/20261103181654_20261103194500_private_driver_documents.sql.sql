/*
# Privacidad de documentos de conductor

1. Seguridad
- El bucket `student-documents` sigue siendo privado.
- Se revocan permisos heredados de anon y authenticated sobre objetos y buckets.
- Los estudiantes solo pueden operar dentro de su propia carpeta.
- Los administradores pueden leer documentos para revisar solicitudes, sin volver público el bucket.

2. Notas
- No se eliminan archivos existentes.
- Los documentos deben consultarse con URLs firmadas y temporales.
*/

UPDATE storage.buckets SET public = false, file_size_limit = 10485760, allowed_mime_types = ARRAY['image/jpeg','image/png','application/pdf'] WHERE id = 'student-documents';
REVOKE ALL ON storage.buckets FROM anon, authenticated;
REVOKE ALL ON storage.objects FROM anon, authenticated;
GRANT SELECT ON storage.objects TO authenticated;
GRANT INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
DROP POLICY IF EXISTS "student_documents_select_admin" ON storage.objects;
CREATE POLICY "student_documents_select_admin" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'student-documents' AND public.is_admin());
DROP POLICY IF EXISTS "student_documents_select_own" ON storage.objects;
CREATE POLICY "student_documents_select_own" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "student_documents_insert_own" ON storage.objects;
CREATE POLICY "student_documents_insert_own" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "student_documents_update_own" ON storage.objects;
CREATE POLICY "student_documents_update_own" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "student_documents_delete_own" ON storage.objects;
CREATE POLICY "student_documents_delete_own" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
