-- Notification columns and SOS verification fields
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS target text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS reference_id uuid;

ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE public.sos_alerts DROP CONSTRAINT IF EXISTS sos_alerts_status_check;
ALTER TABLE public.sos_alerts ADD CONSTRAINT sos_alerts_status_check CHECK (status IN ('ACTIVE','VERIFYING','RESOLVED'));
ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS auto_triggered boolean NOT NULL DEFAULT false;
ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS verification_started_at timestamptz;
ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS verified_by text;
ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS resolution_method text;
ALTER TABLE public.sos_alerts ADD COLUMN IF NOT EXISTS resolution_note text;
UPDATE public.sos_alerts SET status = 'RESOLVED' WHERE resolved_at IS NOT NULL AND status <> 'RESOLVED';

ALTER TABLE public.trip_requests ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE public.trip_requests ALTER COLUMN requested_at SET DEFAULT now();

-- Fix: QR validation must not mark the request COMPLETED (blocks arrival confirmation)
CREATE OR REPLACE FUNCTION public.validate_ride_qr(token_input text)
RETURNS TABLE(valid boolean, request_id uuid, trip_id uuid, passenger_id uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
DECLARE
  req public.trip_requests%ROWTYPE;
  driver_of_trip uuid;
BEGIN
  SELECT * INTO req FROM public.trip_requests q WHERE q.qr_token = token_input;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'TOKEN_NO_ENCONTRADO'; RETURN; END IF;
  SELECT t.driver_id INTO driver_of_trip FROM public.trips t WHERE t.id = req.trip_id;
  IF driver_of_trip IS DISTINCT FROM auth.uid() THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF req.qr_used_at IS NOT NULL THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_YA_USADO'; RETURN; END IF;
  IF req.status <> 'ACCEPTED' THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'SOLICITUD_NO_ACEPTADA'; RETURN; END IF;
  IF req.qr_issued_at + interval '2 hours' < now() THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_EXPIRADO'; RETURN; END IF;
  UPDATE public.trip_requests q SET qr_used_at = now(), trip_started_at = now() WHERE q.id = req.id;
  UPDATE public.trips t SET status = 'IN_PROGRESS' WHERE t.id = req.trip_id AND t.status IN ('PUBLISHED','FULL');
  RETURN QUERY SELECT true, req.id, req.trip_id, req.passenger_id, 'OK';
END;
$$;

-- Driver marks arrival at destination (does not change the request status)
CREATE OR REPLACE FUNCTION public.complete_ride(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
DECLARE trip_row public.trips%ROWTYPE;
BEGIN
  SELECT * INTO trip_row FROM public.trips t WHERE t.id = trip_uuid;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'VIAJE_NO_EXISTE'; RETURN; END IF;
  IF trip_row.driver_id <> auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF trip_row.status <> 'IN_PROGRESS' THEN RETURN QUERY SELECT false, 'VIAJE_NO_ACTIVO'; RETURN; END IF;
  UPDATE public.trips t SET status = 'COMPLETED', updated_at = now() WHERE t.id = trip_uuid;
  UPDATE public.trip_requests q SET trip_completed_at = now() WHERE q.trip_id = trip_uuid AND q.status = 'ACCEPTED' AND q.trip_completed_at IS NULL;
  RETURN QUERY SELECT true, 'OK';
END;
$$;

-- Passenger confirms arrival after the driver registered it
CREATE OR REPLACE FUNCTION public.passenger_confirm_arrival(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
DECLARE req public.trip_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM public.trip_requests q WHERE q.trip_id = trip_uuid AND q.passenger_id = auth.uid() AND q.status = 'ACCEPTED';
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'SOLICITUD_NO_ENCONTRADA'; RETURN; END IF;
  IF req.trip_completed_at IS NULL THEN RETURN QUERY SELECT false, 'LLEGADA_NO_REGISTRADA'; RETURN; END IF;
  IF req.passenger_confirmed_at IS NOT NULL THEN RETURN QUERY SELECT false, 'YA_CONFIRMADO'; RETURN; END IF;
  UPDATE public.trip_requests q SET passenger_confirmed_at = now() WHERE q.id = req.id;
  RETURN QUERY SELECT true, 'OK';
END;
$$;

-- Notification helper and triggers
CREATE OR REPLACE FUNCTION public.notify_user(p_user uuid, p_title text, p_message text, p_type text, p_target text, p_reference uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  INSERT INTO public.notifications (user_id, title, message, type, target, reference_id)
  VALUES (p_user, p_title, p_message, p_type, p_target, p_reference);
$$;

CREATE OR REPLACE FUNCTION public.on_trip_request_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE d uuid;
BEGIN
  SELECT t.driver_id INTO d FROM public.trips t WHERE t.id = NEW.trip_id;
  PERFORM public.notify_user(d, 'Nueva solicitud de viaje', 'Un pasajero solicitó un lugar en tu viaje.', 'TRIP', 'trips', NEW.trip_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.on_trip_request_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE d uuid;
BEGIN
  SELECT t.driver_id INTO d FROM public.trips t WHERE t.id = NEW.trip_id;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'ACCEPTED' THEN
      PERFORM public.notify_user(NEW.passenger_id, 'Solicitud aceptada', 'Tu solicitud de viaje fue aceptada. Tu código QR ya está disponible.', 'TRIP', 'trips', NEW.trip_id);
    ELSIF NEW.status = 'REJECTED' THEN
      PERFORM public.notify_user(NEW.passenger_id, 'Solicitud rechazada', 'Tu solicitud de viaje fue rechazada.', 'TRIP', 'trips', NEW.trip_id);
    ELSIF NEW.status = 'CANCELLED' THEN
      PERFORM public.notify_user(d, 'Solicitud cancelada', 'Un pasajero canceló su solicitud.', 'TRIP', 'trips', NEW.trip_id);
    END IF;
  END IF;
  IF NEW.trip_started_at IS NOT NULL AND OLD.trip_started_at IS NULL THEN
    PERFORM public.notify_user(NEW.passenger_id, 'Tu viaje ha comenzado', 'El conductor verificó tu QR y el viaje está en curso.', 'TRIP', 'trips', NEW.trip_id);
  END IF;
  IF NEW.trip_completed_at IS NOT NULL AND OLD.trip_completed_at IS NULL THEN
    PERFORM public.notify_user(NEW.passenger_id, 'Tu viaje ha finalizado', 'Confirma que llegaste bien para cerrar tu acompañamiento.', 'SAFETY', 'security', NEW.trip_id);
    PERFORM public.notify_user(d, 'Confirmación de seguridad pendiente', 'Tu viaje terminó. Falta la confirmación de llegada del pasajero.', 'SAFETY', 'trips', NEW.trip_id);
  END IF;
  IF NEW.passenger_confirmed_at IS NOT NULL AND OLD.passenger_confirmed_at IS NULL THEN
    PERFORM public.notify_user(d, 'Pasajero confirmó su llegada', 'Un pasajero confirmó que llegó bien.', 'TRIP', 'trips', NEW.trip_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.on_sos_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.notify_user(NEW.user_id,
    CASE WHEN NEW.auto_triggered THEN 'Protocolo SOS automático activado' ELSE 'Alerta de seguridad registrada' END,
    CASE WHEN NEW.auto_triggered THEN 'No confirmaste tu llegada a tiempo. Revisa el incidente en Seguridad.' ELSE 'Registramos tu alerta. Revisa el detalle en Seguridad.' END,
    'SAFETY', 'security', NEW.id);
  IF NEW.trip_id IS NOT NULL AND NEW.role = 'STUDENT' THEN
    PERFORM public.notify_user((SELECT t.driver_id FROM public.trips t WHERE t.id = NEW.trip_id), 'Alerta de seguridad en tu viaje', 'Un pasajero activó una alerta de seguridad.', 'SAFETY', 'security', NEW.id);
  ELSIF NEW.trip_id IS NOT NULL AND NEW.role = 'DRIVER' THEN
    PERFORM public.notify_user(q.passenger_id, 'Alerta de seguridad en tu viaje', 'El conductor activó una alerta de seguridad.', 'SAFETY', 'security', NEW.id)
      FROM public.trip_requests q WHERE q.trip_id = NEW.trip_id AND q.status = 'ACCEPTED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.on_sos_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'RESOLVED' AND OLD.status <> 'RESOLVED' THEN
    PERFORM public.notify_user(NEW.user_id, 'La alerta de seguridad fue resuelta', 'Tu alerta quedó cerrada con verificación registrada.', 'SAFETY', 'security', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trip_request_insert ON public.trip_requests;
CREATE TRIGGER trg_trip_request_insert AFTER INSERT ON public.trip_requests FOR EACH ROW EXECUTE FUNCTION public.on_trip_request_insert();
DROP TRIGGER IF EXISTS trg_trip_request_update ON public.trip_requests;
CREATE TRIGGER trg_trip_request_update AFTER UPDATE ON public.trip_requests FOR EACH ROW EXECUTE FUNCTION public.on_trip_request_update();
DROP TRIGGER IF EXISTS trg_sos_insert ON public.sos_alerts;
CREATE TRIGGER trg_sos_insert AFTER INSERT ON public.sos_alerts FOR EACH ROW EXECUTE FUNCTION public.on_sos_insert();
DROP TRIGGER IF EXISTS trg_sos_update ON public.sos_alerts;
CREATE TRIGGER trg_sos_update AFTER UPDATE ON public.sos_alerts FOR EACH ROW EXECUTE FUNCTION public.on_sos_update();

-- SOS: server picks the active trip and role
CREATE OR REPLACE FUNCTION public.trigger_sos(p_lat double precision, p_lng double precision, p_message text DEFAULT NULL)
RETURNS TABLE(ok boolean, alert_id uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
DECLARE
  uid uuid := auth.uid();
  existing_id uuid;
  current_trip uuid;
  alert_role text := 'STUDENT';
  new_id uuid;
BEGIN
  IF uid IS NULL THEN RETURN QUERY SELECT false, NULL::uuid, 'NO_AUTENTICADO'; RETURN; END IF;
  IF (p_lat IS NULL) <> (p_lng IS NULL) OR (p_lat IS NOT NULL AND (p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180)) THEN
    RETURN QUERY SELECT false, NULL::uuid, 'UBICACION_INVALIDA'; RETURN;
  END IF;
  SELECT s.id INTO existing_id FROM public.sos_alerts s WHERE s.user_id = uid AND s.status <> 'RESOLVED' ORDER BY s.created_at DESC LIMIT 1;
  IF FOUND THEN RETURN QUERY SELECT true, existing_id, 'YA_ACTIVA'; RETURN; END IF;
  SELECT t.id INTO current_trip FROM public.trips t WHERE t.driver_id = uid AND t.status = 'IN_PROGRESS' ORDER BY t.departure_at DESC LIMIT 1;
  IF FOUND THEN
    alert_role := 'DRIVER';
  ELSE
    SELECT q.trip_id INTO current_trip FROM public.trip_requests q
      WHERE q.passenger_id = uid AND q.status = 'ACCEPTED' AND q.trip_started_at IS NOT NULL AND q.passenger_confirmed_at IS NULL
      ORDER BY q.trip_started_at DESC LIMIT 1;
  END IF;
  INSERT INTO public.sos_alerts (user_id, trip_id, role, latitude, longitude, message, status)
  VALUES (uid, current_trip, alert_role, p_lat, p_lng, left(coalesce(nullif(btrim(p_message), ''), 'SOS activado por el usuario'), 200), 'ACTIVE')
  RETURNING id INTO new_id;
  RETURN QUERY SELECT true, new_id, 'OK';
END;
$$;

-- SOS: arrival not confirmed in 10 minutes escalates automatically (once per trip)
CREATE OR REPLACE FUNCTION public.escalate_overdue_arrivals()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.sos_alerts (user_id, trip_id, role, latitude, longitude, message, status, auto_triggered)
  SELECT q.passenger_id, q.trip_id, 'STUDENT', NULL, NULL,
         'SOS automático: no se confirmó la llegada 10 minutos después del evento', 'ACTIVE', true
  FROM public.trip_requests q
  WHERE q.passenger_id = auth.uid() AND q.status = 'ACCEPTED'
    AND q.trip_completed_at IS NOT NULL AND q.passenger_confirmed_at IS NULL
    AND q.trip_completed_at < now() - interval '10 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM public.sos_alerts s WHERE s.user_id = q.passenger_id AND s.trip_id = q.trip_id AND s.auto_triggered
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- SOS verification: start, then resolve with evidence
DROP FUNCTION IF EXISTS public.resolve_sos(uuid);

CREATE OR REPLACE FUNCTION public.start_sos_verification(alert_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
BEGIN
  UPDATE public.sos_alerts SET status = 'VERIFYING', verification_started_at = now()
    WHERE id = alert_uuid AND user_id = auth.uid() AND status = 'ACTIVE';
  IF FOUND THEN RETURN QUERY SELECT true, 'OK'; ELSE RETURN QUERY SELECT false, 'NO_DISPONIBLE'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_sos(alert_uuid uuid, p_verified_by text, p_method text, p_note text)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $$
BEGIN
  IF length(btrim(coalesce(p_verified_by, ''))) < 3 THEN RETURN QUERY SELECT false, 'FALTA_QUIEN_CONFIRMA'; RETURN; END IF;
  IF coalesce(p_method, '') NOT IN ('CONFIRMO_EN_APP', 'VERIFICO_LLAMADA', 'REPORTE_911', 'FALSA_ALARMA') THEN RETURN QUERY SELECT false, 'METODO_INVALIDO'; RETURN; END IF;
  IF length(btrim(coalesce(p_note, ''))) < 10 THEN RETURN QUERY SELECT false, 'FALTA_EVIDENCIA'; RETURN; END IF;
  UPDATE public.sos_alerts SET status = 'RESOLVED', resolved_at = now(), verified_by = btrim(p_verified_by),
      resolution_method = p_method, resolution_note = btrim(p_note)
    WHERE id = alert_uuid AND user_id = auth.uid() AND status = 'VERIFYING';
  IF FOUND THEN RETURN QUERY SELECT true, 'OK'; ELSE RETURN QUERY SELECT false, 'NO_EN_VERIFICACION'; END IF;
END;
$$;

-- Access: trigger helpers are never callable by clients
REVOKE EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.on_trip_request_insert() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.on_trip_request_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.on_sos_insert() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.on_sos_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_ride_qr(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trigger_sos(double precision, double precision, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.escalate_overdue_arrivals() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.start_sos_verification(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.resolve_sos(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trigger_sos(double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.escalate_overdue_arrivals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_sos_verification(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sos(uuid, text, text, text) TO authenticated;

-- Column-level write access: clients cannot change request status, QR or arrival fields
REVOKE ALL ON public.trip_requests FROM anon, authenticated;
GRANT SELECT ON public.trip_requests TO authenticated;
GRANT INSERT (trip_id, passenger_id, fare) ON public.trip_requests TO authenticated;

REVOKE ALL ON public.sos_alerts FROM anon, authenticated;
GRANT SELECT ON public.sos_alerts TO authenticated;

REVOKE ALL ON public.notifications FROM anon, authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

REVOKE ALL ON public.emergency_contacts FROM anon;

-- Incident visibility: owner, driver of the trip, and passengers for driver incidents
CREATE POLICY "sos_alerts_select_trip_driver" ON public.sos_alerts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trips t WHERE t.id = sos_alerts.trip_id AND t.driver_id = auth.uid()));
CREATE POLICY "sos_alerts_select_trip_passenger" ON public.sos_alerts FOR SELECT TO authenticated
  USING (sos_alerts.role = 'DRIVER' AND EXISTS (SELECT 1 FROM public.trip_requests q WHERE q.trip_id = sos_alerts.trip_id AND q.passenger_id = auth.uid() AND q.status = 'ACCEPTED'));
