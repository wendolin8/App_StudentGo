/*
# Notify students about driver application decisions

1. Purpose
- Extend the existing administrative driver review RPC so every approved or rejected application creates an internal notification.

2. Modified function
- `public.review_driver_application`
- Keeps the existing administrator-only check, application and vehicle status changes, and profile promotion.
- Adds a notification addressed to the applicant after the decision.

3. Security
- The RPC remains `SECURITY DEFINER` with `search_path = public, auth`.
- Only authenticated callers may execute it, and the function still requires `public.is_admin()`.
- The notification helper remains non-callable by browser roles.

4. Notes
- No user can promote themselves from the frontend.
- Rejected applications include the administrator's reason when one is supplied.
*/

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

  PERFORM public.notify_user(
    target_user,
    CASE WHEN p_approved THEN 'Solicitud de conductor aprobada' ELSE 'Solicitud de conductor rechazada' END,
    CASE WHEN p_approved THEN 'Tu registro como conductor fue aprobado. Ya puedes publicar viajes.' ELSE 'Tu registro como conductor fue rechazado. Motivo: ' || coalesce(nullif(btrim(p_reason), ''), 'Revisa tus documentos y vuelve a enviarlos.') END,
    'TRIP',
    'profile',
    p_application_id
  );

  RETURN QUERY SELECT true, next_status;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.review_driver_application(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_driver_application(uuid, boolean, text) TO authenticated;