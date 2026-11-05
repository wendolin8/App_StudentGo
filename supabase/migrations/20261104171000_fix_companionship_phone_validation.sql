-- Correct the E.164 regular expression introduced in the previous migration.
-- The previous body stored two backslashes before +, which required a literal backslash.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef('public.create_ride_companion(uuid,text,text,text,text,boolean,boolean)'::regprocedure)
    INTO function_definition;
  function_definition := replace(
    function_definition,
    $needle$'^\\+[1-9][0-9]{9,14}$'$needle$,
    $replacement$'^\+[1-9][0-9]{9,14}$'$replacement$
  );
  EXECUTE function_definition;
END;
$$;
