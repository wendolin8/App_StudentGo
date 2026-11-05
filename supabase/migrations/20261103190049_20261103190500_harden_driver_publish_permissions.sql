/*
# Harden direct driver publishing permissions

1. Purpose
- Ensure an authenticated browser cannot bypass the approved-driver workflow by inserting a published trip directly into `public.trips`.
- Ensure a vehicle submitted directly through the Data API cannot be marked approved by its owner.

2. Modified tables and policies
- `public.trips`: replace the owner insert policy so the caller must own an approved vehicle linked to an approved driver application, with valid document dates.
- `public.vehicles`: replace the owner insert policy so owners may only create vehicles in `PENDING_REVIEW` or `REJECTED` status for their own application.

3. Security changes
- The existing protected `publish_trip_with_vehicle` function remains the supported publishing path and continues to validate approval server-side.
- Direct Data API inserts now enforce the same approval boundary.
- No user roles, profile data, existing trips, vehicles, or applications are deleted or changed.

4. Important notes
- `ADMIN` access remains determined by the functional role in `public.profiles`, not by the Supabase `authenticated` role or by email address.
- This migration does not add public role selectors or change the authentication screen.
*/

DROP POLICY IF EXISTS "trips_insert_owner" ON public.trips;
CREATE POLICY "trips_insert_approved_driver" ON public.trips
FOR INSERT TO authenticated
WITH CHECK (
  driver_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.vehicles v
    JOIN public.driver_applications a ON a.id = v.application_id
    WHERE v.id = trips.vehicle_id
      AND v.owner_id = auth.uid()
      AND v.status = 'APPROVED'
      AND a.user_id = auth.uid()
      AND a.status = 'APPROVED'
      AND v.license_expires_at >= current_date
      AND v.registration_expires_at >= current_date
  )
);

DROP POLICY IF EXISTS "vehicles_insert_owner" ON public.vehicles;
CREATE POLICY "vehicles_insert_owner_pending" ON public.vehicles
FOR INSERT TO authenticated
WITH CHECK (
  owner_id = auth.uid()
  AND status IN ('PENDING_REVIEW', 'REJECTED')
  AND EXISTS (
    SELECT 1
    FROM public.driver_applications a
    WHERE a.id = vehicles.application_id
      AND a.user_id = auth.uid()
  )
);