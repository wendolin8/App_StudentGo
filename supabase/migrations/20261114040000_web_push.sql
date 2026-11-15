-- Subscriptions are private capability URLs; access is mediated by the Edge Function.
CREATE TABLE public.web_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 20 AND 2048),
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_push_user_idx ON public.web_push_subscriptions(user_id);
ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_push_subscriptions FROM anon, authenticated;
GRANT ALL ON public.web_push_subscriptions TO service_role;

CREATE TABLE public.web_push_test_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.web_push_test_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_push_test_limits FROM anon, authenticated;
GRANT ALL ON public.web_push_test_limits TO service_role;

-- The Edge Function derives p_user from auth.getUser, never from a caller-supplied ID.
CREATE FUNCTION public.register_web_push(p_user uuid, p_endpoint text, p_p256dh text, p_auth text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE existing public.web_push_subscriptions; result uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  SELECT * INTO existing FROM public.web_push_subscriptions WHERE endpoint = p_endpoint FOR UPDATE;
  IF FOUND THEN
    IF existing.user_id <> p_user THEN
      RAISE EXCEPTION 'Subscription belongs to another account' USING ERRCODE = '23505';
    END IF;
    UPDATE public.web_push_subscriptions SET p256dh = p_p256dh, auth = p_auth, updated_at = now()
      WHERE id = existing.id;
    RETURN existing.id;
  END IF;
  IF (SELECT count(*) FROM public.web_push_subscriptions WHERE user_id = p_user) >= 10 THEN
    RAISE EXCEPTION 'Device limit reached' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.web_push_subscriptions(user_id, endpoint, p256dh, auth)
    VALUES (p_user, p_endpoint, p_p256dh, p_auth) RETURNING id INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.register_web_push(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_web_push(uuid,text,text,text) TO service_role;

CREATE FUNCTION public.reserve_web_push_test(p_user uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result uuid;
BEGIN
  INSERT INTO public.web_push_test_limits(user_id) VALUES (p_user)
    ON CONFLICT (user_id) DO UPDATE SET requested_at = now()
    WHERE web_push_test_limits.requested_at < now() - interval '60 seconds'
    RETURNING user_id INTO result;
  RETURN result IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_web_push_test(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_web_push_test(uuid) TO service_role;
