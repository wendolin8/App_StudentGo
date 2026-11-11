-- A trip with all seats assigned is valid: it transitions to FULL with zero seats.
-- This changes only the validation rule; it does not delete or alter existing trip data.
ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_available_seats_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_available_seats_check
  CHECK (available_seats >= 0);
