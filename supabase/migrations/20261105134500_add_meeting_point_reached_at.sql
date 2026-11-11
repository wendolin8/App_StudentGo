-- Persist the conductor's arrival at the meeting point for the ride lifecycle UI.
-- Additive and safe for existing trips: previously created rows remain unchanged.
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS meeting_point_reached_at timestamptz;
