/*
# Preserve complete driver application review history

1. Modified table
- `public.driver_applications.reviewed_at`: timestamp for the final administrative decision.
- `public.driver_applications.reviewed_by`: administrator profile that made the final decision.

2. Existing data
- Backfill reviewed_at/reviewed_by for already approved applications from approved_at/approved_by.
- No application, vehicle, profile, authentication record, or document is deleted.

3. Function behavior
- `public.review_driver_application` records reviewer and decision time for approvals and rejections.
- It continues to accept only PENDING_REVIEW applications, so resolved applications cannot be approved again.
- Approval continues to promote the applicant to DRIVER and approve the linked vehicle.

4. Security
- The RPC remains administrator-only, SECURITY DEFINER, and has no anonymous EXECUTE permission.
- Review audit fields are written only by the server-side RPC.
*/

ALTER TABLE public.driver_applications
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

UPDATE public.driver_applications
SET reviewed_at = approved_at,
    reviewed_by = approved_by
WHERE status = 'APPROVED'
  AND reviewed_at IS NULL;

CREATE OR REPLACE FUNCTION public.review_driver_application(p_application_id uuid, p_approved boolean, p_reason text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  next_status text;
  target_user uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN QUERY SELECT false, 'NO_AUTORIZADO';
    RETURN;
  END IF;

  SELECT user_id INTO target_user
  FROM public.driver_applications
  WHERE id = p_application_id AND status = 'PENDING_REVIEW';

  IF target_user IS NULL THEN
    RETURN QUERY SELECT false, 'SOLICITUD_NO_DISPONIBLE';
    RETURN;
  END IF;

  next_status := CASE WHEN p_approved THEN 'APPROVED' ELSE 'REJECTED' END;

  UPDATE public.driver_applications
  SET status = next_status,
      rejection_reason = CASE WHEN p_approved THEN NULL ELSE left(btrim(coalesce(p_reason, '')), 500) END,
      approved_at = CASE WHEN p_approved THEN now() ELSE NULL END,
      approved_by = CASE WHEN p_approved THEN auth.uid() ELSE NULL END,
      reviewed_at = now(),
      reviewed_by = auth.uid(),
      updated_at = now()
  WHERE id = p_application_id;

  UPDATE public.vehicles
  SET status = next_status, updated_at = now()
  WHERE application_id = p_application_id;

  UPDATE public.profiles
  SET role = CASE WHEN p_approved THEN 'DRIVER' ELSE role END,
      driver_verified = p_approved,
      updated_at = now()
  WHERE id = target_user;

  RETURN QUERY SELECT true, next_status;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.review_driver_application(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_driver_application(uuid, boolean, text) TO authenticated;