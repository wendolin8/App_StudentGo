-- Expose each passenger's own QR and validate it atomically for the trip owner.
CREATE OR REPLACE FUNCTION public.get_my_ride_qr(p_trip_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT q.qr_token
  FROM public.trip_requests q
  WHERE q.trip_id = p_trip_id
    AND q.passenger_id = auth.uid()
    AND q.status = 'ACCEPTED'
    AND q.qr_token IS NOT NULL
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_ride_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_ride_qr(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_ride_qr(token_input text)
RETURNS TABLE(valid boolean, request_id uuid, trip_id uuid, passenger_id uuid, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  req public.trip_requests%ROWTYPE;
  trip_row public.trips%ROWTYPE;
  changed_rows integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'NO_AUTENTICADO';
    RETURN;
  END IF;

  SELECT q.* INTO req FROM public.trip_requests q WHERE q.qr_token = token_input FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'TOKEN_NO_ENCONTRADO';
    RETURN;
  END IF;

  SELECT t.* INTO trip_row FROM public.trips t WHERE t.id = req.trip_id FOR UPDATE;
  IF NOT FOUND OR trip_row.driver_id IS DISTINCT FROM auth.uid() THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'NO_ES_CONDUCTOR';
    RETURN;
  END IF;
  IF req.qr_used_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_YA_USADO';
    RETURN;
  END IF;
  IF req.status <> 'ACCEPTED' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'SOLICITUD_NO_ACEPTADA';
    RETURN;
  END IF;
  IF req.qr_issued_at IS NULL OR req.qr_issued_at + interval '2 hours' < now() THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_EXPIRADO';
    RETURN;
  END IF;
  IF trip_row.status NOT IN ('PUBLISHED', 'FULL', 'IN_PROGRESS') THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'VIAJE_NO_ACTIVO';
    RETURN;
  END IF;

  UPDATE public.trip_requests q
  SET qr_used_at = now(), trip_started_at = coalesce(q.trip_started_at, now())
  WHERE q.id = req.id AND q.qr_used_at IS NULL AND q.status = 'ACCEPTED';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_YA_USADO';
    RETURN;
  END IF;

  IF trip_row.status IN ('PUBLISHED', 'FULL') THEN
    UPDATE public.trips SET status = 'IN_PROGRESS', updated_at = now() WHERE id = req.trip_id;
  END IF;
  RETURN QUERY SELECT true, req.id, req.trip_id, req.passenger_id, 'OK';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.validate_ride_qr(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_ride_qr(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_ride(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE trip_row public.trips%ROWTYPE;
BEGIN
  SELECT * INTO trip_row FROM public.trips t WHERE t.id = trip_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'VIAJE_NO_EXISTE'; RETURN; END IF;
  IF trip_row.driver_id IS DISTINCT FROM auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF trip_row.status <> 'IN_PROGRESS' THEN RETURN QUERY SELECT false, 'VIAJE_NO_ACTIVO'; RETURN; END IF;
  UPDATE public.trips SET status = 'COMPLETED', updated_at = now() WHERE id = trip_uuid;
  UPDATE public.trip_requests SET trip_completed_at = now()
    WHERE trip_id = trip_uuid AND status = 'ACCEPTED'
      AND trip_started_at IS NOT NULL AND trip_completed_at IS NULL;
  RETURN QUERY SELECT true, 'OK';
END;
$$;

-- Administrators can move incidents through verification and resolution from their panel.
CREATE OR REPLACE FUNCTION public.start_sos_verification(alert_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN QUERY SELECT false, 'NO_AUTENTICADO'; RETURN; END IF;
  UPDATE public.sos_alerts SET status = 'VERIFYING', verification_started_at = now()
    WHERE id = alert_uuid AND status = 'ACTIVE'
      AND (user_id = auth.uid() OR public.is_admin());
  IF FOUND THEN RETURN QUERY SELECT true, 'OK';
  ELSE RETURN QUERY SELECT false, 'NO_DISPONIBLE'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_sos(alert_uuid uuid, p_verified_by text, p_method text, p_note text)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN QUERY SELECT false, 'NO_AUTENTICADO'; RETURN; END IF;
  IF length(btrim(coalesce(p_verified_by, ''))) < 3 THEN RETURN QUERY SELECT false, 'FALTA_QUIEN_CONFIRMA'; RETURN; END IF;
  IF coalesce(p_method, '') NOT IN ('CONFIRMO_EN_APP', 'VERIFICO_LLAMADA', 'REPORTE_911', 'FALSA_ALARMA') THEN RETURN QUERY SELECT false, 'METODO_INVALIDO'; RETURN; END IF;
  IF length(btrim(coalesce(p_note, ''))) < 10 THEN RETURN QUERY SELECT false, 'FALTA_EVIDENCIA'; RETURN; END IF;
  UPDATE public.sos_alerts SET status = 'RESOLVED', resolved_at = now(), verified_by = btrim(p_verified_by),
    resolution_method = p_method, resolution_note = btrim(p_note)
    WHERE id = alert_uuid AND status = 'VERIFYING'
      AND (user_id = auth.uid() OR public.is_admin());
  IF FOUND THEN RETURN QUERY SELECT true, 'OK';
  ELSE RETURN QUERY SELECT false, 'NO_EN_VERIFICACION'; END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_sos_verification(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_sos_verification(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_sos(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_sos(uuid, text, text, text) TO authenticated;
