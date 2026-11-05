/*
# Protect vehicle ownership during driver resubmission

1. Purpose
- Prevent a driver from using an existing license plate to update another user's vehicle while resubmitting documents.

2. Modified function
- `public.submit_driver_application`
- Rejects plates already assigned to another owner.
- Allows a rejected owner to resubmit only their own vehicle.

3. Security
- Ownership is checked from `auth.uid()` inside the SECURITY DEFINER function.
- The browser cannot choose or override the vehicle owner.
- Existing approval and publication checks remain unchanged.
*/

CREATE OR REPLACE FUNCTION public.submit_driver_application(p_brand text, p_model text, p_year integer, p_color text, p_plates text, p_capacity integer, p_license_path text, p_registration_card_path text, p_license_expires_at date, p_registration_expires_at date)
RETURNS TABLE(ok boolean, application_id uuid, vehicle_id uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  app_id uuid;
  vehicle_id_out uuid;
  uid uuid := auth.uid();
  existing_owner uuid;
BEGIN
  IF uid IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'NO_AUTENTICADO';
    RETURN;
  END IF;
  IF length(btrim(coalesce(p_brand, ''))) < 2 OR length(btrim(coalesce(p_model, ''))) < 1 OR length(btrim(coalesce(p_color, ''))) < 2 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'DATOS_INCOMPLETOS';
    RETURN;
  END IF;
  IF p_plates !~ '^[A-Z0-9 -]{5,10}$' OR p_year < 1950 OR p_year > extract(year from now())::integer + 1 OR p_capacity < 1 OR p_capacity > 8 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'VEHICULO_INVALIDO';
    RETURN;
  END IF;
  IF p_license_expires_at < current_date OR p_registration_expires_at < current_date THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'DOCUMENTO_VENCIDO';
    RETURN;
  END IF;
  IF p_license_path !~ ('^' || uid::text || '/') OR p_registration_card_path !~ ('^' || uid::text || '/') THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'DOCUMENTO_INVALIDO';
    RETURN;
  END IF;

  SELECT owner_id INTO existing_owner
  FROM public.vehicles
  WHERE lower(plates) = lower(btrim(p_plates));

  IF existing_owner IS NOT NULL AND existing_owner <> uid THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'PLACAS_EN_USO';
    RETURN;
  END IF;

  INSERT INTO public.driver_applications (user_id, status, submitted_at, updated_at)
  VALUES (uid, 'PENDING_REVIEW', now(), now())
  ON CONFLICT (user_id) DO UPDATE SET status = 'PENDING_REVIEW', rejection_reason = NULL, submitted_at = now(), approved_at = NULL, approved_by = NULL, updated_at = now()
  RETURNING id INTO app_id;

  INSERT INTO public.vehicles (application_id, owner_id, brand, model, vehicle_year, color, plates, passenger_capacity, license_path, registration_card_path, license_expires_at, registration_expires_at, status)
  VALUES (app_id, uid, btrim(p_brand), btrim(p_model), p_year, btrim(p_color), upper(btrim(p_plates)), p_capacity, p_license_path, p_registration_card_path, p_license_expires_at, p_registration_expires_at, 'PENDING_REVIEW')
  ON CONFLICT (lower(plates)) DO UPDATE SET application_id = EXCLUDED.application_id, brand = EXCLUDED.brand, model = EXCLUDED.model, vehicle_year = EXCLUDED.vehicle_year, color = EXCLUDED.color, passenger_capacity = EXCLUDED.passenger_capacity, license_path = EXCLUDED.license_path, registration_card_path = EXCLUDED.registration_card_path, license_expires_at = EXCLUDED.license_expires_at, registration_expires_at = EXCLUDED.registration_expires_at, status = 'PENDING_REVIEW', updated_at = now()
  WHERE public.vehicles.owner_id = uid
  RETURNING id INTO vehicle_id_out;

  IF vehicle_id_out IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'PLACAS_EN_USO';
    RETURN;
  END IF;

  RETURN QUERY SELECT true, app_id, vehicle_id_out, 'PENDING_REVIEW';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_driver_application(text, text, integer, text, text, integer, text, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_driver_application(text, text, integer, text, text, integer, text, text, date, date) TO authenticated;