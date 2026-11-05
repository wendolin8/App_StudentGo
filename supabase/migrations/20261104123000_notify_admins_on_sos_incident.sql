-- Notify every admin inside Student Go when a manual or companion-reported SOS is created.
-- External contact messaging remains disabled until a provider is configured.

CREATE OR REPLACE FUNCTION public.on_sos_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  admin_id uuid;
BEGIN
  PERFORM public.notify_user(
    NEW.user_id,
    CASE WHEN NEW.auto_triggered THEN 'Protocolo SOS automatico activado' ELSE 'Alerta de seguridad registrada' END,
    CASE WHEN NEW.auto_triggered THEN 'No confirmaste tu llegada a tiempo. Revisa el incidente en Seguridad.' ELSE 'Registramos tu alerta. Revisa el detalle en Seguridad.' END,
    'SAFETY', 'security', NEW.id
  );

  FOR admin_id IN
    SELECT p.id FROM public.profiles p WHERE p.role = 'ADMIN' AND p.id <> NEW.user_id
  LOOP
    PERFORM public.notify_user(
      admin_id,
      'Nueva alerta SOS',
      'Se registro una alerta de seguridad. Revisa el incidente y su contexto en el panel administrativo.',
      'SAFETY', 'security', NEW.id
    );
  END LOOP;

  IF NEW.trip_id IS NOT NULL AND NEW.role = 'STUDENT' THEN
    PERFORM public.notify_user(
      (SELECT t.driver_id FROM public.trips t WHERE t.id = NEW.trip_id),
      'Alerta de seguridad en tu viaje',
      'Un pasajero activo en tu viaje registro una alerta de seguridad.',
      'SAFETY', 'security', NEW.id
    );
  ELSIF NEW.trip_id IS NOT NULL AND NEW.role = 'DRIVER' THEN
    PERFORM public.notify_user(
      q.passenger_id,
      'Alerta de seguridad en tu viaje',
      'El conductor activo registro una alerta de seguridad.',
      'SAFETY', 'security', NEW.id
    ) FROM public.trip_requests q WHERE q.trip_id = NEW.trip_id AND q.status = 'ACCEPTED';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_sos_insert() FROM PUBLIC, anon, authenticated;
